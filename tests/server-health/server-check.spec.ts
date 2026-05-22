// Auto-generated from config/project-mapping.json — do not edit manually
import { test, expect } from '@playwright/test';

const SERVERS = [
  {
    "name": "AdHash — Adhash - Web",
    "url": "https://adhashtech.com/"
  },
  {
    "name": "WavedIn — WavedIn - Mobile API",
    "url": "https://mobileliveapi.wavedin.app/"
  },
  {
    "name": "WavedIn — WavedIn - Super Admin",
    "url": "https://superadmin.wavedin.app/"
  },
  {
    "name": "Algomax — Algomax - GoPocket",
    "url": "https://gopocket.algomax.co/"
  },
  {
    "name": "AutoChecker — AutoChecker - Auto Search",
    "url": "http://20.7.146.191:3000/"
  },
  {
    "name": "AutoChecker — AutoChecker - Manual Search",
    "url": "http://20.15.121.70:3000/"
  },
  {
    "name": "AutoChecker — AutoChecker - PartSouq",
    "url": "http://20.62.109.239:3000/"
  },
  {
    "name": "AutoChecker — AutoChecker - Admin",
    "url": "https://manage.autochecker.com/"
  },
  {
    "name": "AutoChecker — AutoChecker - Admin API",
    "url": "https://manageadminapi.autochecker.com/"
  },
  {
    "name": "AutoChecker — AutoChecker - Mobile API",
    "url": "https://managemobileapi.autochecker.com/"
  },
  {
    "name": "AutoChecker — AutoChecker - eBay API",
    "url": "https://ebaydev.autochecker.com/"
  },
  {
    "name": "Spark me — Spark me - API",
    "url": "https://spark.synctag.com/"
  },
  {
    "name": "Humee — Humee - Admin",
    "url": "https://humee.com/"
  },
  {
    "name": "Humee — Humee - API",
    "url": "https://api.humee.com/"
  },
  {
    "name": "Metcalf — Metcalf - Web",
    "url": "https://metcalf.ai/"
  },
  {
    "name": "AiSign Pro — AiSignPro - API",
    "url": "https://api.aisignpro.com/"
  },
  {
    "name": "AiSign Pro — AiSignPro - Admin",
    "url": "https://admin.aisignpro.com/"
  },
  {
    "name": "ZapCRM — Zapcrm - API",
    "url": "https://api.zapcrm.io/"
  },
  {
    "name": "ZapCRM — Zapcrm - Admin",
    "url": "https://zapcrm.io/"
  },
  {
    "name": "ZapCRM — Zapcrm - Secure",
    "url": "https://secure.zapcrm.io/"
  },
  {
    "name": "ZapCRM — Zapcrm - Social",
    "url": "https://social.zapcrm.io/"
  },
  {
    "name": "LeadZapCRM — Zapcrm - Lead",
    "url": "https://lead.zapcrm.io/"
  },
  {
    "name": "ZapAI — Zapai - Web",
    "url": "https://www.zapai.us/"
  },
  {
    "name": "SMC — SMC - API",
    "url": "https://api.sendmovieclips.com/"
  },
  {
    "name": "Synctag — Synctag - API",
    "url": "https://extensionapi.synctag.com/"
  },
  {
    "name": "Synctag — Synctag - Web",
    "url": "https://synctag.com/"
  },
  {
    "name": "DDP — DDP - Website",
    "url": "https://www.ddphub.ai/"
  },
  {
    "name": "DDP — DDP - Supabase",
    "url": "https://twfnwlccyudfgqjmmdva.supabase.co/"
  }
];

for (const server of SERVERS) {
  test(`Server Health: ${server.name}`, async ({ request }) => {
    const res = await request.get(server.url, { timeout: 30000, failOnStatusCode: false });
    expect(res.status(), `${server.url} returned ${res.status()}`).toBeLessThan(500);
  });
}
