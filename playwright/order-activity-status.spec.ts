import { test, expect } from '@playwright/test';
const statuses = ['out_for_delivery','delivered','payment_disputed','cancellation_pending','completed','future_state'];
for (const width of [320,375,1280]) {
 test(`activity status and counts at ${width}px`, async ({ page }) => {
  await page.setViewportSize({width,height:900});
  await page.route('**/*', async route => {
   const url=new URL(route.request().url());
   if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return route.abort();
   if (!url.pathname.startsWith('/api/')) return route.continue();
   if(url.pathname==='/api/auth/user') return route.fulfill({json:{id:'synthetic-customer',userType:'customer',emailVerified:true,profileComplete:true,accountOnboardingComplete:true,nextRequiredStep:'complete'}});
   if(url.pathname==='/api/my/orders') return route.fulfill({json:{orders:statuses.map((status,i)=>({id:`synthetic-${i}`,status,orderType:'pickup',paymentMethod:'card',totalCents:1200,createdAt:'2026-11-10T12:00:00Z'}))}});
   if(url.pathname==='/api/deals/claimed') return route.fulfill({json:[]});
   return route.fulfill({json:[]});
  });
  await page.goto('/orders');
  await expect(page.getByText('4 active',{exact:true})).toBeVisible();
  await expect(page.getByText('1 past',{exact:true})).toBeVisible();
  await expect(page.getByText('1 status unavailable',{exact:true})).toBeVisible();
  for(const label of ['Out for delivery','Delivered','Payment under review','Cancellation processing','Completed','Status unavailable']) await expect(page.getByText(label,{exact:true})).toBeVisible();
  await expect(page.getByText('Received',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('link',{name:'View status'})).toHaveCount(6);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByTestId('tab-customer-deals').click();
  await expect(page.getByText('No claimed deals yet',{exact:true})).toBeVisible();
  await page.getByTestId('tab-customer-orders').click();
  await expect(page.getByText('4 active',{exact:true})).toBeVisible();
 });
}
