import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderActivityStatus, countOrderActivity } from '../client/src/lib/order-activity-status';

const expected = [
  ['pending', 'Received', 'active'], ['confirmed', 'Confirmed', 'active'],
  ['preparing', 'Preparing', 'active'], ['ready', 'Ready', 'active'],
  ['out_for_delivery', 'Out for delivery', 'active'], ['delivered', 'Delivered', 'active'],
  ['payment_disputed', 'Payment under review', 'active'],
  ['cancellation_pending', 'Cancellation processing', 'active'],
  ['completed', 'Completed', 'past'], ['cancelled', 'Cancelled', 'past'],
];
for (const [status,label,group] of expected) test(`${status} has truthful activity presentation`, () => {
  assert.equal(orderActivityStatus(status).label, label);
  assert.equal(orderActivityStatus(status).group, group);
});
test('formerly missing states are counted, delivered stays active until completed', () => {
  assert.deepEqual(countOrderActivity(['out_for_delivery','delivered','payment_disputed','cancellation_pending','completed'].map(status => ({status}))), {active:4,past:1,unknown:0});
});
test('unknown/prototype statuses never pretend order received', () => {
  for (const status of ['future_status', '', 'constructor', '__proto__']) assert.equal(orderActivityStatus(status).label, 'Status unavailable');
});
test('all rows counted exactly once without mutation', () => {
  const orders=Object.freeze([...expected.map(([status])=>Object.freeze({status})),Object.freeze({status:'future'})]);
  assert.deepEqual(countOrderActivity(orders), {active:8,past:2,unknown:1});
});
test('empty activity', () => assert.deepEqual(countOrderActivity([]), {active:0,past:0,unknown:0}));
