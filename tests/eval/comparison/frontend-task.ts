import type { ComparisonTask } from "./tasks";

export const FRONTEND_TASK: ComparisonTask = {
  id: "responsive-project-board",
  browser: true,
  prompt: `Build a polished, responsive project dashboard for "Fieldnotes Studio" in index.html, using projects.json as the starting data. Serve it as static files; no external dependencies or assets. Design direction: calm editorial workspace, warm off-white background, dark ink, restrained green accent, clear type hierarchy and spacing, distinct desktop and mobile layouts. Show the studio name, a useful summary, project cards with name, status and description, a labelled search input named "Search projects", and filter buttons "All", "Active", "Archived". Start on All. Searching and status filtering combine. Every card has a keyboard-operable favorite toggle with accessible name "Favorite <project name>" and aria-pressed; persist favorites on reload using localStorage. Use data-project-id on each rendered card so external integrations can identify it. Display an empty state when nothing matches. Keep mobile at 390px free of horizontal overflow; desktop at 1440px must use multiple card columns. Use visible keyboard focus and sufficient contrast. Verify search, filters, persistence, keyboard interaction and both viewport layouts in a real browser, and inspect screenshots before finishing. Playwright is already installed: import the module identified by the RUNE_BENCH_PLAYWRIGHT environment variable from Bun/Node, use its chromium launcher. Keep screenshots inside this workspace. Add a concise README with how to serve and test it. Do not install packages or deploy anything.`,
  files: {
    "index.html":
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fieldnotes Studio</title></head><body><h1>Fieldnotes Studio</h1><p>Dashboard under construction.</p></body></html>\n',
    "projects.json":
      JSON.stringify(
        [
          {
            id: "kestrel",
            name: "Kestrel",
            status: "Active",
            description: "A quieter home for a neighborhood ceramics studio.",
          },
          {
            id: "northstar",
            name: "Northstar",
            status: "Active",
            description: "An identity and digital journal for a new research collective.",
          },
          {
            id: "morrow",
            name: "Morrow",
            status: "Archived",
            description: "A seasonal catalogue built around materials and makers.",
          },
          {
            id: "linen",
            name: "Linen",
            status: "Active",
            description: "A thoughtful booking experience for independent spaces.",
          },
          {
            id: "coast",
            name: "Coast",
            status: "Archived",
            description: "Field guides and stories from the water's edge.",
          },
          {
            id: "arc",
            name: "Arc",
            status: "Active",
            description: "A small publication with room for ambitious ideas.",
          },
        ],
        null,
        2,
      ) + "\n",
  },
  checks: `
    const { chromium } = await import(process.env.RUNE_BENCH_PLAYWRIGHT);
    const server = Bun.serve({port:0, hostname:'127.0.0.1', fetch(req) {
      const path = new URL(req.url).pathname; const relative = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
      if (relative.split('/').includes('..')) return new Response('forbidden',{status:403});
      return new Response(Bun.file(join(root,relative)));
    }});
    const browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors = []; page.on('pageerror',e=>errors.push(e.message));
    try {
      await page.goto('http://127.0.0.1:'+server.port, {waitUntil:'networkidle'});
      await page.locator('[data-project-id="kestrel"]').waitFor();
      const cards = page.locator('[data-project-id]:visible'); assert.equal(await cards.count(),6);
      const boxes = await cards.evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}}));
      assert.ok(boxes.some((a,i)=>boxes.some((b,j)=>i!==j && Math.abs(a.y-b.y)<10 && Math.abs(a.x-b.x)>100)), 'desktop needs multiple card columns');
      assert.ok(boxes.every(b=>b.w>=180 && b.h>=70));
      await page.screenshot({path:join(process.cwd(),'desktop.png'),fullPage:true});
      const fav = page.getByRole('button',{name:'Favorite Kestrel',exact:true});
      await fav.focus(); await page.keyboard.press('Enter'); assert.equal(await fav.getAttribute('aria-pressed'),'true');
      await page.reload({waitUntil:'networkidle'}); assert.equal(await page.getByRole('button',{name:'Favorite Kestrel',exact:true}).getAttribute('aria-pressed'),'true');
      await page.getByRole('button',{name:'Archived',exact:true}).click(); assert.equal(await cards.count(),2);
      await page.getByRole('button',{name:'All',exact:true}).click();
      // Native type=search has the searchbox role; the brief requires the
      // accessible label, not a particular input type or ARIA role.
      const search = page.getByLabel('Search projects',{exact:true});
      await search.fill('kestrel'); await page.waitForTimeout(350); assert.equal(await cards.count(),1);
      await page.getByRole('button',{name:'Archived',exact:true}).click(); assert.equal(await cards.count(),0);
      assert.match(await page.locator('body').innerText(), /no (?:projects|results|matches)|nothing (?:found|matches)/i);
      await page.getByRole('button',{name:'All',exact:true}).click(); await search.fill(''); await page.waitForTimeout(350);
      await page.setViewportSize({width:390,height:844}); await page.screenshot({path:join(process.cwd(),'mobile.png'),fullPage:true});
      assert.equal(await cards.count(),6);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1), 'mobile horizontal overflow');
      const mobileBoxes=await cards.evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,right:r.right,w:r.width}}));
      assert.ok(mobileBoxes.every(b=>b.x>=-1 && b.right<=391 && b.w>=180));
      assert.deepEqual(errors,[],'browser errors');
    } finally {await browser.close();server.stop(true);}`,
};
