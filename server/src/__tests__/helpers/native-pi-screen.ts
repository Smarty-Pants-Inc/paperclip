import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Optional real built UI capture, against this row's own HTTP/DB instance. */
export async function nativePiScreen(root: string, url: string) {
  if (!process.env.PAPERCLIP_A2_CHROMIUM_MODULE) return null;
  const { default: installed } = await import(pathToFileURL(process.env.PAPERCLIP_A2_CHROMIUM_MODULE).href);
  const browser = await chromium.launch({ executablePath: await installed.executablePath(), args: installed.args, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByTestId("task-chat-turn-status-header").first().waitFor({ state: "visible", timeout: 15_000 });
  } catch (error) {
    await page.screenshot({ path: join(root, "screen-load-failed.png"), fullPage: true }).catch(() => undefined);
    await writeFile(join(root, "screen-load-failed.json"), JSON.stringify({ url, errors, body: await page.locator("body").innerText() }, null, 2));
    await context.close();
    await browser.close();
    throw error;
  }
  const frames: Array<{ at: number; name: string; text: string; headers: string[] }> = [];
  return {
    async frame(name: string) {
      if (name === "answer") await page.getByText("19", { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
      const at = Date.now();
      const text = await page.locator("body").innerText();
      const headers = await page.locator('[data-testid="task-chat-turn-status-header"]').allTextContents();
      frames.push({ at, name, text, headers });
      await page.screenshot({ path: join(root, `screen-${name}.png`), fullPage: true });
      await writeFile(join(root, "screen-frames.json"), JSON.stringify({ url, frames, errors }, null, 2));
      return { at, text, headers };
    },
    async phone(name: string) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(root, `screen-${name}-390.png`), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
    async close() { await context.close(); await browser.close(); },
  };
}
