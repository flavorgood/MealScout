import assert from 'node:assert/strict';
import {linkHubSignupToSharedProfile} from '../server/hubIdentityClient.ts';
process.env.TRADESCOUT_API_BASE='https://fixture.invalid';process.env.HUB_IDENTITY_SECRET='fixture';
let count=0;global.fetch=async()=>{count++;return {ok:true,status:200,json:async()=>({})}};
for(const emailVerified of [undefined,null,false]) await linkHubSignupToSharedProfile({id:'fixture',email:'fixture@example.invalid',emailVerified});
assert.equal(count,0);
await linkHubSignupToSharedProfile({id:'fixture',email:'fixture@example.invalid',emailVerified:true});assert.equal(count,1);
console.log('PASS: unverified/missing/null blocked, verified invokes resolver; offline only. No storage writes exercised.');
