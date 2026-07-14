#!/usr/bin/env node
// Reusable Playwright verify script. Usage: node scripts/verify.mjs <check-name>
// Always closes the browser in finally — critical on this VPS (no swap).
import { chromium } from 'playwright';

const BASE_URL = process.env.VERIFY_BASE_URL || 'http://127.0.0.1:3464/schedule-tracker/';
const PASSCODE = process.env.SCHEDULE_PASSCODE || '';

const checks = {
  async reactivity(page) {
    await login(page);
    const firstSlot = page.locator('.slot').first();
    await firstSlot.waitFor({ state: 'visible', timeout: 10000 });

    // Delay POST responses so a network round-trip would visibly lag behind a real optimistic update.
    await page.route('**/schedule-tracker-api/status', async route => {
      await new Promise(r => setTimeout(r, 3000));
      await route.continue();
    });

    const doneBtn = firstSlot.locator('.ibtn').first();
    const wasOn = await doneBtn.evaluate(el => el.classList.contains('on'));
    await doneBtn.click();

    const start = Date.now();
    await firstSlot.evaluate((el, prevOn) => new Promise(resolve => {
      const check = () => {
        const nowOn = el.classList.contains('done');
        if (nowOn !== prevOn) return resolve();
        requestAnimationFrame(check);
      };
      check();
    }), wasOn && doneBtn ? true : false).catch(() => {});
    const elapsed = Date.now() - start;

    const hasClass = await firstSlot.evaluate(el => el.classList.contains('done'));
    await page.screenshot({ path: '/tmp/verify-reactivity.png' }).catch(() => {});
    if (hasClass && elapsed < 2500) {
      return { pass: true, detail: `class flipped after ${elapsed}ms, before the 3000ms delayed POST resolved` };
    }
    return { pass: false, detail: `hasClass=${hasClass} elapsed=${elapsed}ms` };
  },

  async pomodoro(page) {
    await login(page);
    await page.screenshot({ path: '/tmp/verify-pomodoro.png' }).catch(() => {});
    const phaseText = await page.locator('#pomo').innerText();
    return { pass: /\d{2}:\d{2}/.test(phaseText), detail: phaseText };
  },

  async ['add-task'](page) {
    await login(page);
    const before = await page.locator('.slot').count();
    const title = `verify-task-${Date.now()}`;
    await page.fill('#task-title', title);
    const now = new Date();
    const start = new Date(now.getTime() + 3600 * 1000);
    const end = new Date(now.getTime() + 2 * 3600 * 1000);
    await page.fill('#task-start', start.toISOString().slice(0, 16));
    await page.fill('#task-end', end.toISOString().slice(0, 16));
    await page.click('#task-add-submit');
    await page.waitForTimeout(1500);
    const after = await page.locator('.slot').count();
    const found = await page.locator('.slot', { hasText: title }).count();
    await page.screenshot({ path: '/tmp/verify-add-task.png' }).catch(() => {});
    return { pass: after > before && found > 0, detail: `before=${before} after=${after} found=${found}` };
  }
};

async function login(page) {
  await page.goto(BASE_URL);
  await page.fill('#passcode-input', PASSCODE);
  await page.click('#gate-submit');
  await page.locator('#app').waitFor({ state: 'visible', timeout: 10000 });
}

async function main() {
  const name = process.argv[2];
  if (!name || !checks[name]) {
    console.error(`usage: node scripts/verify.mjs <${Object.keys(checks).join('|')}>`);
    process.exit(1);
  }
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const result = await checks[name](page);
    console.log(result.pass ? 'PASS' : 'FAIL', '-', result.detail);
    process.exit(result.pass ? 0 : 1);
  } catch (err) {
    console.log('FAIL', '-', err.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

main();
