// Explicit test ports. Real HTTP, express-session, Socket.IO and Engine.IO are
// loaded unchanged; only storage and unused business projections are replaced.
export const users = new Map([
  ['fixture-owner', { id: 'fixture-owner', userType: 'restaurant_owner', isDisabled: false }],
  ['fixture-other', { id: 'fixture-other', userType: 'restaurant_owner', isDisabled: false }],
  ['fixture-disabled', { id: 'fixture-disabled', userType: 'restaurant_owner', isDisabled: true }],
]);

export const storage = {
  async getUser(id) { return users.get(id) ?? null; },
  async verifyRestaurantOwnership(restaurantId, userId) {
    return restaurantId === 'fixture-restaurant' && userId === 'fixture-owner';
  },
};
// No fixture actor receives an admin bypass. Owner checks exercise storage.
export function isAdminUserType() { return false; }
export function incConnect() {}
export function incDisconnect() {}
export function incSubscribeNearby() {}
export function maybeWarnIfChurn() {}
const unexercised = () => { throw new Error('Public projections are outside this fixture scope.'); };
export const toPublicRestaurantListingArrayWithVisibility = unexercised;
export const toPublicRestaurantListingWithVisibility = unexercised;
export const deriveProfileEvidenceQuarantineVisibility = unexercised;
export const isPublicBusinessVisible = unexercised;
