import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectPublicLocalMenuItemRow } from '../server/services/publicLocalMenuItemProjection';
import { publicRestaurantDistanceKm } from '../server/services/publicRestaurantSearchProjection';

const now = new Date();
const row = { id:'synthetic-dish', name:'Synthetic taco', restaurantId:'synthetic-truck', restaurantOwnerId:'synthetic-owner', restaurantName:'Lantern Lunch Truck', restaurantAddress:'Private administrative base', restaurantLatitude:40, restaurantLongitude:-80, restaurantCurrentLatitude:30.01, restaurantCurrentLongitude:-97, restaurantMobileOnline:true, restaurantLastBroadcastAt:now, restaurantLiveUntilAt:new Date(now.getTime()+3600000), restaurantIsActive:true, isFoodTruck:true, businessType:'food_truck', priceCents:900 };
const visibility = { ownerEnabled:true, showAddress:false, showContact:false };
function distance(value: Record<string, unknown>) { return publicRestaurantDistanceKm({ latitude:value.restaurantLatitude, longitude:value.restaurantLongitude },30,-97); }

test('menu discovery retains only canonical public live coordinates for a mobile business', () => {
 const projected=projectPublicLocalMenuItemRow(row,visibility); assert.ok(projected);
 assert.equal(projected.publicRow.restaurantLatitude,30.01); assert.equal(projected.publicRow.restaurantLongitude,-97);
 assert.ok(distance(projected.publicRow)! > 1 && distance(projected.publicRow)! < 2);
 assert.ok(!JSON.stringify(projected.publicRow).includes('Private administrative base'));
});
test('stale or offline truck menu never falls back to its private administrative base', () => {
 for(const patch of [{restaurantLastBroadcastAt:new Date('2000-01-01'),restaurantLiveUntilAt:null},{restaurantMobileOnline:false}]) {
  const projected=projectPublicLocalMenuItemRow({...row,...patch},visibility); assert.ok(projected); assert.equal(distance(projected.publicRow),null);
 }
});
test('hidden owner and private static locations remain undiscoverable by distance', () => {
 assert.equal(projectPublicLocalMenuItemRow(row,{...visibility,ownerEnabled:false}),null);
 const projected=projectPublicLocalMenuItemRow({...row,isFoodTruck:false,businessType:'restaurant'},visibility);assert.ok(projected);assert.equal(distance(projected.publicRow),null);
});
