import { Server as SocketIOServer } from "socket.io";
import type { Server, IncomingMessage, ServerResponse } from "http";
import { storage } from "./storage";
import type { Request, Response, RequestHandler } from "express";
import type { Session } from "express-session";
import type { Socket } from "socket.io";
import type { InsertFoodTruckLocation } from "@shared/schema";
import { isAdminUserType } from "./roleAccess";
import {
  incConnect,
  incDisconnect,
  incSubscribeNearby,
  maybeWarnIfChurn,
} from "./utils/realtimeMetrics";
import {
  toPublicRestaurantListingArrayWithVisibility,
  toPublicRestaurantListingWithVisibility,
} from "./publicProfiles/toPublicRestaurantListingWithVisibility";
import { deriveProfileEvidenceQuarantineVisibility } from "./services/profileEvidenceQuarantine";
import { isPublicBusinessVisible } from "./utils/publicBusinessVisibility";

type ClientToServerEvents = {
  subscribe_nearby: (data: {
    latitude: number;
    longitude: number;
    radiusKm?: number;
  }) => void;
  subscribe_restaurant: (data: { restaurantId: string }) => void;
  subscribe_kitchen: (data: { restaurantId: string }) => void;
  unsubscribe_kitchen: (data: { restaurantId: string }) => void;
  unsubscribe: (data: { room?: string }) => void;
  ping: () => void;
};

type NearbyTruck = Record<string, unknown>;

type BroadcastLocation = {
  latitude: number | string;
  longitude: number | string;
  timestamp?: string;
  accuracy?: number | string | null;
  speed?: number | string | null;
  heading?: number | string | null;
  altitude?: number | string | null;
  [key: string]: unknown;
};

type PublicBroadcastLocation = {
  latitude: number;
  longitude: number;
  timestamp: string;
};

type ServerToClientEvents = {
  nearby_trucks: (payload: { trucks: NearbyTruck[] }) => void;
  error: (payload: { message: string }) => void;
  subscribed: (payload: { restaurantId: string; room: string }) => void;
  unsubscribed: (payload: { room: string }) => void;
  pong: (payload: Record<string, never>) => void;
  lisa_claim: (payload: {
    type: "lisa_claim";
    claim: {
      id?: string;
      lane: string;
      app: string;
      source: string;
      claimType: string;
      subjectType: string;
      subjectId: string;
      actorType?: string | null;
      actorId?: string | null;
      claimValue: Record<string, unknown>;
      confidence?: string | number | null;
      createdAt: string;
    };
  }) => void;
  location_update: (payload: {
    type: "location_update";
    restaurantId: string;
    location: BroadcastLocation;
    timestamp: string;
  }) => void;
  truck_location_update: (payload: {
    type: "truck_location_update";
    restaurantId: string;
    location: PublicBroadcastLocation;
    timestamp: string;
  }) => void;
  status_update: (payload: {
    restaurantId: string;
    status: { isOnline: boolean; mobileOnline?: boolean };
  }) => void;
  "kitchen:order_update": (payload: { order: Record<string, unknown> }) => void;
};

type InterServerEvents = Record<string, never>;

type SocketData = {
  userId?: string | null;
  sessionID?: string;
  user?: Awaited<ReturnType<typeof storage.getUser>> | null;
};

type RealtimeSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
> & {
  userId?: string | null;
  sessionID?: string;
  user?: Awaited<ReturnType<typeof storage.getUser>> | null;
};

type SessionRequest = IncomingMessage & {
  session?: Session & { passport?: { user?: string } };
  sessionID?: string;
};

// Global WebSocket server instance
let io: SocketIOServer | null = null;

// Store user subscriptions for cleanup
const userSubscriptions = new Map<string, Set<string>>();

export function setupWebSocketServer(
  httpServer: Server,
  sessionMiddleware: RequestHandler,
): SocketIOServer {
  // Create Socket.IO server with restricted CORS
  const defaultOrigins = [
    "http://localhost:5000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
    "https://meal-scout.vercel.app",
    "https://mealscout.us",
    "https://www.mealscout.us",
    "https://mealscout.onrender.com",
    "https://thetradescout.com",
    "https://www.thetradescout.com",
    "https://tradescout.onrender.com",
  ];
  const extraOrigins = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const allowedOrigins = Array.from(
    new Set([...defaultOrigins, ...extraOrigins]),
  );
  const isAllowedOrigin = (origin: string | undefined) => {
    if (!origin) return true; // Native nonbrowser policy; hosted v2 requires Origin.
    try {
      const parsed = new URL(origin);
      const defaultPort = parsed.protocol === "https:" ? "443" : "80";
      return (origin === parsed.origin || origin === `${parsed.origin}:${defaultPort}`) &&
        allowedOrigins.includes(parsed.origin);
    } catch { return false; }
  };
  io = new SocketIOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    path: "/socket.io",
    cors: {
      origin: function (origin, callback) {
        if (isAllowedOrigin(origin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["polling", "websocket"],
  });

  type NativeAuthority = {
    host: string;
    origin: string | undefined;
    userId: string | null;
    sessionID: string | undefined;
    user: RealtimeSocket["user"];
  };
  const verifiedRequests = new WeakMap<IncomingMessage, NativeAuthority>();
  const engineAuthorities = new Map<string, NativeAuthority>();

  // Engine.IO middleware runs for initial polling, polling with sid, and
  // WebSocket upgrades BEFORE Engine.IO verifies/opens the transport (101).
  // Reuse HTTP's exact native cookie/secret/store; no second session store.
  io.engine.use((req: IncomingMessage, res: ServerResponse, next: (error?: Error) => void) => {
    sessionMiddleware(req as Request, res as Response, (error) => {
      if (error) { next(error); return; }
      void (async () => {
        const rawTarget = req.url || "";
        const target = new URL(rawTarget, "http://native.invalid");
        if (rawTarget.split("?", 1)[0] !== "/socket.io/" || target.pathname !== "/socket.io/" ||
            target.searchParams.getAll("EIO").length !== 1 ||
            target.searchParams.get("EIO") !== "4" ||
            target.searchParams.getAll("transport").length !== 1 ||
            !["polling", "websocket"].includes(target.searchParams.get("transport") || "") ||
            target.searchParams.getAll("sid").length > 1) {
          throw new Error("Invalid native realtime target");
        }
        const origin = req.headers.origin;
        if (!isAllowedOrigin(origin)) {
          throw new Error("Invalid native realtime origin");
        }
        const nativeRequest = req as SessionRequest;
        const userId = nativeRequest.session?.passport?.user ?? null;
        if (userId !== null && (typeof userId !== "string" || !userId)) {
          throw new Error("Invalid native realtime session");
        }
        const user = userId ? await storage.getUser(userId) : null;
        if (userId && (!user || user.id !== userId || user.isDisabled || !nativeRequest.sessionID)) {
          throw new Error("Native realtime account unavailable");
        }
        if (req.aborted || req.socket.destroyed) return;
        const authority: NativeAuthority = {
          host: String(req.headers.host || "").toLowerCase(),
          origin: origin ? new URL(origin).origin : undefined,
          userId,
          sessionID: userId ? nativeRequest.sessionID : undefined,
          user,
        };
        const sid = target.searchParams.get("sid");
        if (sid !== null) {
          const existing = engineAuthorities.get(sid);
          if (!existing || existing.host !== authority.host || existing.origin !== authority.origin ||
              existing.userId !== authority.userId || existing.sessionID !== authority.sessionID) {
            throw new Error("Native realtime transport/session mismatch");
          }
        }
        verifiedRequests.set(req, authority);
        next();
      })().catch(() => {
        if (!req.aborted && !req.socket.destroyed) next(new Error("Native realtime authorization failed"));
      });
    });
  });
  io.engine.on("connection", (transport: {
    id: string;
    request: IncomingMessage;
    close(force?: boolean): void;
    once(event: "close", listener: () => void): void;
  }) => {
    const authority = verifiedRequests.get(transport.request);
    if (!authority) { transport.close(true); return; }
    engineAuthorities.set(transport.id, authority);
    transport.once("close", () => {
      if (engineAuthorities.get(transport.id) === authority) engineAuthorities.delete(transport.id);
    });
  });
  io.use((socket, next) => {
    if (!verifiedRequests.has(socket.request)) {
      next(new Error("Native realtime session unavailable"));
      return;
    }
    next();
  });

  // Native public discovery remains anonymous; private rooms retain their
  // existing native ownership checks. SDK auth/user/role claims are unused.
  io.on("connection", (socket: RealtimeSocket) => {
        const authority = verifiedRequests.get(socket.request)!;
        incConnect();
        socket.userId = authority.userId;
        socket.sessionID = authority.sessionID || `anon_${socket.id}`;
        socket.user = authority.user;
        if (["staff", "admin", "duper_admin", "super_admin"].includes(String(socket.user?.userType || ""))) {
          socket.join("admin_lisa");
        }

        // Initialize user subscriptions tracking
        const userKey =
          socket.userId || socket.sessionID || `fallback_${socket.id}`;
        if (!userSubscriptions.has(userKey)) {
          userSubscriptions.set(userKey, new Set());
        }

        // Handle subscription to nearby trucks by location
        socket.on(
          "subscribe_nearby",
          async (data: {
            latitude: number;
            longitude: number;
            radiusKm?: number;
          }) => {
            try {
              incSubscribeNearby();
              const { latitude, longitude, radiusKm = 5 } = data;

              // Validate coordinates
              if (
                typeof latitude !== "number" ||
                typeof longitude !== "number" ||
                latitude < -90 ||
                latitude > 90 ||
                longitude < -180 ||
                longitude > 180 ||
                (latitude === 0 && longitude === 0)
              ) {
                socket.emit("error", { message: "Invalid coordinates" });
                return;
              }

              // Create geographic room key (grid-based approach for efficiency)
              const gridSize = 0.1; // ~11km grid squares
              const gridLat = Math.floor(latitude / gridSize) * gridSize;
              const gridLng = Math.floor(longitude / gridSize) * gridSize;
              const roomKey = `grid_${gridLat}_${gridLng}`;

              // Leave previous geographic rooms
              const userSubs = userSubscriptions.get(userKey);
              if (userSubs) {
                userSubs.forEach((room) => {
                  if (room.startsWith("grid_")) {
                    socket.leave(room);
                    userSubs.delete(room);
                  }
                });
              }

              // Join new geographic room
              socket.join(roomKey);
              userSubs?.add(roomKey);

              // Send initial nearby trucks data
              const nearbyTrucks = await storage.getLiveTrucksNearby(
                latitude,
                longitude,
                Math.max(1, Math.min(50, Number(radiusKm) || 5)),
              );
              const authorizedNearbyTrucks = (
                await Promise.all(
                  nearbyTrucks.map(async (candidate: any) => {
                    const fullRestaurant = await storage.getRestaurant(
                      String(candidate?.id || ""),
                    );
                    if (
                      !fullRestaurant ||
                      fullRestaurant.isActive !== true ||
                      fullRestaurant.mobileOnline !== true ||
                      !isPublicBusinessVisible(fullRestaurant) ||
                      deriveProfileEvidenceQuarantineVisibility(fullRestaurant)
                        .isQuarantined
                    ) {
                      return null;
                    }
                    return fullRestaurant;
                  }),
                )
              ).filter(Boolean);
              const publicNearbyTrucks =
                await toPublicRestaurantListingArrayWithVisibility(
                  authorizedNearbyTrucks,
                );
              socket.emit("nearby_trucks", { trucks: publicNearbyTrucks });

              console.log(
                `User ${userKey} subscribed to nearby trucks in ${roomKey}`,
              );
            } catch (error) {
              console.error("Error handling nearby subscription:", error);
              socket.emit("error", {
                message: "Failed to subscribe to nearby trucks",
              });
            }
          },
        );

        // Handle subscription to specific restaurant updates (for owners)
        socket.on("subscribe_restaurant", async (data) => {
          try {
            const { restaurantId } = data;

            if (!socket.user) {
              socket.emit("error", { message: "Authentication required" });
              return;
            }

            // Verify user owns this restaurant
            const isAuthorized = await storage.verifyRestaurantOwnership(
              restaurantId,
              socket.user.id,
              "manageProfile",
            );
            if (!isAuthorized) {
              socket.emit("error", {
                message:
                  "Unauthorized: You can only subscribe to restaurants you own",
              });
              return;
            }

            const roomKey = `restaurant_${restaurantId}`;
            socket.join(roomKey);
            userSubscriptions.get(userKey)?.add(roomKey);

            socket.emit("subscribed", { restaurantId, room: roomKey });
            console.log(
              `User ${userKey} subscribed to restaurant ${restaurantId}`,
            );
          } catch (error) {
            console.error("Error handling restaurant subscription:", error);
            socket.emit("error", {
              message: "Failed to subscribe to restaurant",
            });
          }
        });

        // Handle kitchen queue subscription (restaurant owners / staff)
        socket.on("subscribe_kitchen", async (data) => {
          try {
            const { restaurantId } = data;

            if (!socket.user) {
              socket.emit("error", { message: "Authentication required" });
              return;
            }

            const isAuthorized =
              isAdminUserType(socket.user.userType) ||
              (await storage.verifyRestaurantOwnership(
                restaurantId,
                socket.user.id,
              ));
            if (!isAuthorized) {
              socket.emit("error", {
                message: "Unauthorized: kitchen access denied",
              });
              return;
            }

            const roomKey = `kitchen:${restaurantId}`;
            socket.join(roomKey);
            userSubscriptions.get(userKey)?.add(roomKey);

            socket.emit("subscribed", { restaurantId, room: roomKey });
            console.log(
              `User ${userKey} subscribed to kitchen queue for ${restaurantId}`,
            );
          } catch (error) {
            console.error("Error handling kitchen subscription:", error);
            socket.emit("error", {
              message: "Failed to subscribe to kitchen queue",
            });
          }
        });

        socket.on("unsubscribe_kitchen", (data) => {
          try {
            const roomKey = `kitchen:${data.restaurantId}`;
            const userSubs = userSubscriptions.get(userKey);
            if (userSubs?.has(roomKey)) {
              socket.leave(roomKey);
              userSubs.delete(roomKey);
              socket.emit("unsubscribed", { room: roomKey });
            }
          } catch (error) {
            console.error("Error handling kitchen unsubscribe:", error);
            socket.emit("error", {
              message: "Failed to unsubscribe from kitchen queue",
            });
          }
        });

        // Handle unsubscribe
        socket.on("unsubscribe", (data) => {
          try {
            const userSubs = userSubscriptions.get(userKey);
            if (data.room && userSubs?.has(data.room)) {
              socket.leave(data.room);
              userSubs.delete(data.room);
              socket.emit("unsubscribed", { room: data.room });
            }
          } catch (error) {
            console.error("Error handling unsubscribe:", error);
            socket.emit("error", { message: "Failed to unsubscribe" });
          }
        });

        // Handle ping for connection keepalive
        socket.on("ping", () => {
          try {
            socket.emit("pong", {});
          } catch (error) {
            console.error("Error handling ping:", error);
          }
        });

        // Handle disconnect
        socket.on("disconnect", (reason) => {
          console.log(
            `WebSocket disconnected: ${socket.id}, reason: ${reason}`,
          );
          incDisconnect();
          maybeWarnIfChurn((msg) => console.warn(msg));

          // Clean up user subscriptions
          userSubscriptions.delete(userKey);
        });
  });

  console.log("Socket.IO server setup complete at default path");
  return io;
}

// Broadcast location update to subscribers
export async function broadcastLocationUpdate(
  restaurantId: string,
  locationData: BroadcastLocation,
) {
  if (!io) {
    console.warn("WebSocket server not initialized");
    return;
  }

  try {
    // Broadcast to restaurant-specific room (for owners)
    const restaurantRoom = `restaurant_${restaurantId}`;
    io.to(restaurantRoom).emit("location_update", {
      type: "location_update",
      restaurantId,
      location: locationData,
      timestamp: new Date().toISOString(),
    });

    // Public grid rooms receive only a server-authorized live coordinate DTO.
    // Owner-only restaurant rooms above retain the richer operational payload.
    if (locationData.latitude && locationData.longitude) {
      const gridSize = 0.1;
      const latNum =
        typeof locationData.latitude === "string"
          ? Number(locationData.latitude)
          : locationData.latitude;
      const lngNum =
        typeof locationData.longitude === "string"
          ? Number(locationData.longitude)
          : locationData.longitude;

      if (
        !Number.isFinite(latNum) ||
        !Number.isFinite(lngNum) ||
        latNum < -90 ||
        latNum > 90 ||
        lngNum < -180 ||
        lngNum > 180 ||
        (latNum === 0 && lngNum === 0)
      ) {
        console.warn("Skipping broadcast: invalid coordinates", locationData);
        return;
      }

      const restaurant = await storage.getRestaurant(restaurantId);
      const publicRestaurant = restaurant
        ? await toPublicRestaurantListingWithVisibility(restaurant)
        : null;
      if (
        !restaurant ||
        restaurant.isActive !== true ||
        !isPublicBusinessVisible(restaurant) ||
        deriveProfileEvidenceQuarantineVisibility(restaurant).isQuarantined ||
        !publicRestaurant?.id ||
        publicRestaurant.mobileOnline !== true
      ) {
        return;
      }
      const publicLat = Number(publicRestaurant.currentLatitude);
      const publicLng = Number(publicRestaurant.currentLongitude);
      if (
        !Number.isFinite(publicLat) ||
        !Number.isFinite(publicLng) ||
        (publicLat === 0 && publicLng === 0)
      ) {
        return;
      }
      const publicTimestamp =
        typeof locationData.timestamp === "string" && locationData.timestamp
          ? locationData.timestamp
          : new Date().toISOString();
      const publicLocation: PublicBroadcastLocation = {
        latitude: publicLat,
        longitude: publicLng,
        timestamp: publicTimestamp,
      };

      const gridLat = Math.floor(publicLat / gridSize) * gridSize;
      const gridLng = Math.floor(publicLng / gridSize) * gridSize;

      // Broadcast to current grid and adjacent grids for seamless coverage
      for (let latOffset = -1; latOffset <= 1; latOffset++) {
        for (let lngOffset = -1; lngOffset <= 1; lngOffset++) {
          const targetGridLat = gridLat + latOffset * gridSize;
          const targetGridLng = gridLng + lngOffset * gridSize;
          const gridRoom = `grid_${targetGridLat}_${targetGridLng}`;

          io.to(gridRoom).emit("truck_location_update", {
            type: "truck_location_update",
            restaurantId,
            location: publicLocation,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    console.log(`Broadcasted location update for restaurant ${restaurantId}`);
  } catch (error) {
    console.error("Error broadcasting location update:", error);
  }
}

// Broadcast status update (online/offline)
export function broadcastStatusUpdate(
  restaurantId: string,
  status: { isOnline: boolean; mobileOnline?: boolean },
) {
  if (!io) {
    console.warn("WebSocket server not initialized");
    return;
  }

  try {
    // Broadcast to restaurant-specific room
    const restaurantRoom = `restaurant_${restaurantId}`;
    io.to(restaurantRoom).emit("status_update", {
      type: "status_update",
      restaurantId,
      status,
      timestamp: new Date().toISOString(),
    });

    // Also broadcast to all geographic rooms if going offline
    if (!status.isOnline) {
      io.emit("truck_status_update", {
        type: "truck_status_update",
        restaurantId,
        status,
        timestamp: new Date().toISOString(),
      });
    }

    console.log(
      `Broadcasted status update for restaurant ${restaurantId}:`,
      status,
    );
  } catch (error) {
    console.error("Error broadcasting status update:", error);
  }
}

export function broadcastLisaClaim(claim: {
  id?: string;
  app: string;
  source: string;
  claimType: string;
  subjectType: string;
  subjectId: string;
  actorType?: string | null;
  actorId?: string | null;
  claimValue: Record<string, unknown>;
  confidence?: string | number | null;
  createdAt?: string | Date | null;
}) {
  if (!io) {
    console.warn("WebSocket server not initialized");
    return;
  }

  try {
    const lane = [
      claim.app || "unknown",
      claim.source || "unknown",
      claim.claimType || "unknown",
      claim.subjectType || "unknown",
    ].join(":");

    io.to("admin_lisa").emit("lisa_claim", {
      type: "lisa_claim",
      claim: {
        ...claim,
        lane,
        createdAt:
          claim.createdAt instanceof Date
            ? claim.createdAt.toISOString()
            : claim.createdAt
              ? String(claim.createdAt)
              : new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error broadcasting LISA claim:", error);
  }
}

// Get WebSocket server instance
export function getWebSocketServer(): SocketIOServer | null {
  return io;
}

// Get connection stats for monitoring
export function getConnectionStats() {
  if (!io) return { totalConnections: 0, rooms: [] };

  const sockets = io.sockets.sockets;
  const rooms = Array.from(io.sockets.adapter.rooms.keys()).filter(
    (room) => !sockets.has(room), // Filter out socket IDs (which are also stored as rooms)
  );

  return {
    totalConnections: sockets.size,
    rooms: rooms,
    userSubscriptions: userSubscriptions.size,
  };
}
