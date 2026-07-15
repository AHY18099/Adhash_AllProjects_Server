import { request } from '@playwright/test';
import nodemailer from 'nodemailer';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

interface EmailConfig {
  service?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  user: string;
  password: string;
  to: string;
}

interface ServerStatus {
  url: string;
  name?: string;
  isActive: boolean;
  statusCode?: number;
  statusText?: string;
  responseTime?: number;
  error?: string;
  timestamp: Date;
}

interface StatusChange {
  url: string;
  name: string;
  previousStatus: string;
  currentStatus: string;
  changeType: 'improved' | 'degraded' | 'critical';
}

interface PreviousStatus {
  url: string;
  status: 'healthy' | 'unhealthy' | 'down';
  timestamp: string;
}

interface ServerEntry {
  url: string;
  name?: string;
}

interface MergeServerEntriesResult {
  entries: ServerEntry[];
  addedRequiredServerCount: number;
}

function parseServerEntries(serverUrlsString: string): ServerEntry[] {
  return serverUrlsString
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const parts = entry.split('|');
      return {
        url: parts[0].trim(),
        name: parts.length > 1 ? parts[1].trim() : undefined
      };
    })
    .filter(entry => entry.url.length > 0);
}

function normalizeServerUrl(url: string): string {
  const trimmedUrl = url.trim();

  try {
    const parsedUrl = new URL(trimmedUrl);
    const pathname = parsedUrl.pathname.replace(/\/+$/, '');
    const normalizedPathname = pathname || '/';

    return `${parsedUrl.protocol.toLowerCase()}//${parsedUrl.host.toLowerCase()}${normalizedPathname}${parsedUrl.search}${parsedUrl.hash}`;
  } catch (error) {
    return trimmedUrl.replace(/\/+$/, '');
  }
}

function mergeServerEntries(primary: ServerEntry[], required: ServerEntry[]): MergeServerEntriesResult {
  const merged = [...primary];
  const seen = new Set(primary.map(entry => normalizeServerUrl(entry.url)));
  let addedRequiredServerCount = 0;

  for (const entry of required) {
    const normalizedUrl = normalizeServerUrl(entry.url);
    if (!seen.has(normalizedUrl)) {
      merged.push(entry);
      seen.add(normalizedUrl);
      addedRequiredServerCount += 1;
    }
  }

  return { entries: merged, addedRequiredServerCount };
}

function extractServerName(url: string): string {
  // Special cases for IP addresses
  if (url.includes('20.62.109.239')) return 'Partsouq';
  if (url.includes('20.15.121.70')) return 'Manual Search';
  if (url.includes('20.7.146.191')) return 'Auto Search';
  if (url.includes('20.1.198.58')) return 'Production Server';

  // Special cases for DDP servers
  if (url.includes('ddphub.ai')) return 'DDP URL';
  if (url.includes('twfnwlccyudfgqjmmdva.supabase.co')) return 'DDP API';

  // Extract domain name from URL
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    // Remove www. if present
    const cleanHostname = hostname.replace(/^www\./, '');

    // Extract the main domain name (before .com, .app, .io, etc.)
    const parts = cleanHostname.split('.');

    // If subdomain exists (like superadmin.wavedin.app), get the second-to-last part
    if (parts.length >= 3) {
      return parts[parts.length - 2]; // Get 'wavedin' from 'superadmin.wavedin.app'
    } else if (parts.length === 2) {
      return parts[0]; // Get 'example' from 'example.com'
    }

    return cleanHostname;
  } catch (error) {
    return 'Unknown';
  }
}

function getServerStatusType(server: ServerStatus): 'healthy' | 'unhealthy' | 'down' {
  if (!server.isActive) return 'down';
  if (server.statusCode && server.statusCode >= 400) return 'unhealthy';
  return 'healthy';
}

function loadPreviousStatus(): Map<string, PreviousStatus> {
  const statusFile = 'previous-status.json';
  const statusMap = new Map<string, PreviousStatus>();

  try {
    if (fs.existsSync(statusFile)) {
      const data = fs.readFileSync(statusFile, 'utf-8');
      const statuses: PreviousStatus[] = JSON.parse(data);
      statuses.forEach(s => statusMap.set(s.url, s));
      console.log(`📂 Loaded previous status for ${statuses.length} server(s)`);
    } else {
      console.log('📂 No previous status file found (first run)');
    }
  } catch (error) {
    console.log('⚠️  Error loading previous status, treating as first run');
  }

  return statusMap;
}

function savePreviousStatus(statuses: ServerStatus[]): void {
  const statusFile = 'previous-status.json';
  const previousStatuses: PreviousStatus[] = statuses.map(s => ({
    url: s.url,
    status: getServerStatusType(s),
    timestamp: new Date().toISOString()
  }));

  try {
    fs.writeFileSync(statusFile, JSON.stringify(previousStatuses, null, 2));
    console.log(`💾 Saved current status for ${previousStatuses.length} server(s)`);
  } catch (error) {
    console.log('⚠️  Error saving status file');
  }
}

function detectStatusChanges(currentStatuses: ServerStatus[], previousStatusMap: Map<string, PreviousStatus>): StatusChange[] {
  const changes: StatusChange[] = [];

  for (const current of currentStatuses) {
    const previous = previousStatusMap.get(current.url);

    if (!previous) {
      // First time checking this server, skip
      continue;
    }

    const currentStatus = getServerStatusType(current);

    if (previous.status !== currentStatus) {
      const change: StatusChange = {
        url: current.url,
        name: current.name || extractServerName(current.url),
        previousStatus: previous.status,
        currentStatus: currentStatus,
        changeType: determineChangeType(previous.status, currentStatus)
      };
      changes.push(change);
    }
  }

  return changes;
}

function determineChangeType(previous: string, current: string): 'improved' | 'degraded' | 'critical' {
  // Critical: healthy/unhealthy -> down
  if (current === 'down' && (previous === 'healthy' || previous === 'unhealthy')) {
    return 'critical';
  }

  // Degraded: healthy -> unhealthy
  if (previous === 'healthy' && current === 'unhealthy') {
    return 'degraded';
  }

  // Improved: down/unhealthy -> healthy, or down -> unhealthy
  return 'improved';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateModernHTMLReport(statuses: ServerStatus[]): string {
  const downServers = statuses.filter(s => !s.isActive);
  const unhealthyServers = statuses.filter(s => s.isActive && s.statusCode && s.statusCode >= 400);
  const healthyServers = statuses.filter(s => s.isActive && s.statusCode && s.statusCode < 400);
  const hasIssues = downServers.length > 0 || unhealthyServers.length > 0;
  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'full',
    timeStyle: 'long'
  });

  const generateServerRows = (servers: ServerStatus[], statusLabel: string, statusClass: string) => {
    return servers.map(s => `
        <tr>
          <td>
            <div class="row-name">${escapeHtml(s.name || 'Unknown')}</div>
            <div class="row-url">${escapeHtml(s.url)}</div>
          </td>
          <td><span class="pill pill-${statusClass}">${statusLabel}</span></td>
          <td class="mono">${s.isActive ? escapeHtml(`${s.statusCode} ${s.statusText}`) : escapeHtml(s.error || 'No response')}</td>
          <td class="mono num">${s.responseTime ? `${s.responseTime} ms` : '—'}</td>
          <td class="mono num">${s.timestamp.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata' })}</td>
        </tr>`).join('');
  };

  const section = (title: string, statusClass: string, servers: ServerStatus[], label: string) => {
    if (servers.length === 0) return '';
    return `
      <section class="group">
        <div class="group-head">
          <span class="dot dot-${statusClass}"></span>
          <h2>${title}</h2>
          <span class="group-count">${servers.length}</span>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Server</th>
                <th>Status</th>
                <th>Detail</th>
                <th class="num">Latency</th>
                <th class="num">Checked</th>
              </tr>
            </thead>
            <tbody>
              ${generateServerRows(servers, label, statusClass)}
            </tbody>
          </table>
        </div>
      </section>`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Server Health Report — ${new Date().toLocaleDateString()}</title>
  <style>
    :root {
      --ink: #0f172a;
      --ink-soft: #475569;
      --line: #e2e8f0;
      --ground: #f6f8fb;
      --card: #ffffff;
      --accent: #2563eb;
      --good: #16a34a;
      --good-bg: #ecfdf3;
      --warn: #d97706;
      --warn-bg: #fffbeb;
      --bad: #dc2626;
      --bad-bg: #fef2f2;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --ink: #e5e9f0;
        --ink-soft: #94a3b8;
        --line: #263041;
        --ground: #0b1220;
        --card: #121a2b;
        --accent: #5b8def;
        --good: #34d399;
        --good-bg: #0d2a1f;
        --warn: #fbbf24;
        --warn-bg: #2c2107;
        --bad: #f87171;
        --bad-bg: #2c1212;
      }
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--ground);
      color: var(--ink);
      padding: 32px 20px;
    }

    .wrap { max-width: 1180px; margin: 0 auto; }

    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 24px;
    }

    .brand { display: flex; align-items: center; gap: 12px; }

    .brand-mark {
      width: 36px; height: 36px;
      border-radius: 8px;
      background: var(--accent);
      display: flex; align-items: center; justify-content: center;
      color: white; font-weight: 700; font-size: 15px;
      flex-shrink: 0;
    }

    .brand-text .name { font-weight: 600; font-size: 15px; }
    .brand-text .sub { font-size: 12.5px; color: var(--ink-soft); }

    .status-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 14px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      background: ${hasIssues ? 'var(--bad-bg)' : 'var(--good-bg)'};
      color: ${hasIssues ? 'var(--bad)' : 'var(--good)'};
    }

    .status-chip .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: currentColor;
    }

    .meta {
      font-size: 13px;
      color: var(--ink-soft);
      margin-bottom: 28px;
      font-variant-numeric: tabular-nums;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 32px;
    }

    .stat {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 18px 20px;
    }

    .stat .label {
      font-size: 12px;
      color: var(--ink-soft);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 8px;
    }

    .stat .value {
      font-size: 30px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }

    .stat.good .value { color: var(--good); }
    .stat.warn .value { color: var(--warn); }
    .stat.bad .value { color: var(--bad); }

    .group { margin-bottom: 28px; }

    .group-head {
      display: flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 12px;
    }

    .group-head h2 {
      font-size: 15px;
      font-weight: 600;
    }

    .group-count {
      font-size: 12px;
      color: var(--ink-soft);
      background: var(--ground);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 1px 8px;
      font-variant-numeric: tabular-nums;
    }

    .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
    .dot-bad { background: var(--bad); }
    .dot-warn { background: var(--warn); }
    .dot-good { background: var(--good); }

    .table-scroll {
      overflow-x: auto;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 10px;
    }

    table { width: 100%; border-collapse: collapse; min-width: 640px; }

    th {
      text-align: left;
      font-size: 11.5px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--ink-soft);
      font-weight: 600;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
    }

    th.num, td.num { text-align: right; }

    td {
      padding: 13px 16px;
      border-bottom: 1px solid var(--line);
      vertical-align: middle;
      font-size: 13.5px;
    }

    tr:last-child td { border-bottom: none; }

    .row-name { font-weight: 600; }
    .row-url { font-size: 12px; color: var(--ink-soft); font-family: 'SFMono-Regular', Consolas, monospace; margin-top: 2px; }

    .mono { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12.5px; color: var(--ink-soft); }
    .num { font-variant-numeric: tabular-nums; }

    .pill {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
    }

    .pill-bad { background: var(--bad-bg); color: var(--bad); }
    .pill-warn { background: var(--warn-bg); color: var(--warn); }
    .pill-good { background: var(--good-bg); color: var(--good); }

    .footer {
      margin-top: 32px;
      padding-top: 20px;
      border-top: 1px solid var(--line);
      font-size: 12.5px;
      color: var(--ink-soft);
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }

    .footer a { color: var(--accent); text-decoration: none; }

    @media (max-width: 720px) {
      .stats { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand">
        <div class="brand-mark">AH</div>
        <div class="brand-text">
          <div class="name">Adhash Technologies</div>
          <div class="sub">Server Health Monitor</div>
        </div>
      </div>
      <span class="status-chip"><span class="dot"></span>${hasIssues ? 'Issues Detected' : 'All Systems Operational'}</span>
    </div>

    <div class="meta">Report generated ${timestamp} · Monitoring ${statuses.length} server(s)</div>

    <div class="stats">
      <div class="stat good">
        <div class="label">Healthy</div>
        <div class="value">${healthyServers.length}</div>
      </div>
      <div class="stat warn">
        <div class="label">Unhealthy</div>
        <div class="value">${unhealthyServers.length}</div>
      </div>
      <div class="stat bad">
        <div class="label">Down</div>
        <div class="value">${downServers.length}</div>
      </div>
      <div class="stat">
        <div class="label">Total Monitored</div>
        <div class="value">${statuses.length}</div>
      </div>
    </div>

    ${section('Down / Inactive', 'bad', downServers, 'DOWN')}
    ${section('Unhealthy', 'warn', unhealthyServers, 'UNHEALTHY')}
    ${section('Healthy', 'good', healthyServers, 'HEALTHY')}

    <div class="footer">
      <span>Automated report · Server Health Monitor</span>
      <span>Questions: <a href="mailto:qateam@adhashtech.com">qateam@adhashtech.com</a></span>
    </div>
  </div>
</body>
</html>`;
}

const AUTOCHECKER_ALERT_IPS = ['20.7.146.191', '20.15.121.70'];

async function postSlackMessage(botToken: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const result: any = await response.json();

    if (!response.ok || !result.ok) {
      console.log(`   ❌ Slack API error: ${result.error || response.status}`);
      return false;
    }

    return true;
  } catch (error: any) {
    console.log(`   ❌ Failed to send Slack message: ${error.message}`);
    return false;
  }
}

function slackStatField(label: string, value: string | number): Record<string, unknown> {
  return { type: 'mrkdwn', text: `*${label}*\n${value}` };
}

async function sendSlackAutoCheckerDownAlert(
  botToken: string,
  channel: string,
  downServers: ServerStatus[],
  reportUrl?: string
): Promise<boolean> {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });

  const serverLines = downServers
    .map(s => `• *${s.name || s.url}* (\`${s.url}\`) — ${s.error || 'No response'}`)
    .join('\n');

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🚨 AutoChecker Scrap Server Down', emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🕒 ${timestamp}` }],
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        slackStatField('Servers Down', downServers.length),
        slackStatField('Alert Type', 'Critical'),
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: serverLines },
    },
  ];

  if (reportUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '📊 View Report', emoji: true },
          url: reportUrl,
          style: 'danger',
        },
      ],
    });
  }

  const sent = await postSlackMessage(botToken, {
    channel,
    text: '🚨 AutoChecker Scrap Server Down',
    blocks,
  });

  if (sent) {
    console.log('   💬 Slack alert sent: AutoChecker Scrap Server Down');
  }

  return sent;
}

async function sendSlackHealthReport(
  botToken: string,
  channel: string,
  statuses: ServerStatus[],
  reportUrl?: string
): Promise<boolean> {
  const downServers = statuses.filter(s => !s.isActive);
  const unhealthyServers = statuses.filter(s => s.isActive && s.statusCode && s.statusCode >= 400);
  const healthyServers = statuses.filter(s => s.isActive && s.statusCode && s.statusCode < 400);
  const hasIssues = downServers.length > 0 || unhealthyServers.length > 0;
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });

  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: hasIssues ? '⚠️ Server Health Check — Issues Found' : '✅ Server Health Check — All Clear',
        emoji: true,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🕒 ${timestamp}` }],
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        slackStatField('Total Servers', statuses.length),
        slackStatField('✅ Healthy', healthyServers.length),
        slackStatField('⚠️ Unhealthy', unhealthyServers.length),
        slackStatField('🚨 Down', downServers.length),
      ],
    },
  ];

  if (reportUrl) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '📊 View Report', emoji: true },
            url: reportUrl,
            style: hasIssues ? 'danger' : 'primary',
          },
        ],
      }
    );
  }

  const sent = await postSlackMessage(botToken, {
    channel,
    text: hasIssues ? '⚠️ Server Health Check — Issues Found' : '✅ Server Health Check — All Clear',
    blocks,
  });

  if (sent) {
    console.log('   💬 Slack health report sent');
  }

  return sent;
}

function saveHTMLReport(statuses: ServerStatus[]): { reportFileName: string; reportPath: string; reportsDir: string } {
  const modernReport = generateModernHTMLReport(statuses);
  const reportsDir = path.join(process.cwd(), 'reports');
  const reportFileName = `server-health-report-${new Date().toISOString().split('T')[0]}.html`;
  const reportPath = path.join(reportsDir, reportFileName);

  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  fs.writeFileSync(reportPath, modernReport, 'utf-8');
  fs.writeFileSync(path.join(reportsDir, 'latest.html'), modernReport, 'utf-8');
  console.log(`   📄 HTML report saved: ${reportPath}`);

  return { reportFileName, reportPath, reportsDir };
}

async function sendMultiServerEmail(
  config: EmailConfig,
  statuses: ServerStatus[],
  report: { reportFileName: string; reportPath: string },
  changes: StatusChange[] = []
) {
  const transportConfig: any = {
    auth: {
      user: config.user,
      pass: config.password,
    },
  };

  if (config.host) {
    transportConfig.host = config.host;
    transportConfig.port = config.port || 465;
    transportConfig.secure = config.secure !== undefined ? config.secure : true;
  } else if (config.service) {
    transportConfig.service = config.service;
  }

  const transporter = nodemailer.createTransport(transportConfig);

  const downServers = statuses.filter(s => !s.isActive);
  const unhealthyServers = statuses.filter(s => s.isActive && s.statusCode && s.statusCode >= 400);
  const healthyServers = statuses.filter(s => s.isActive && s.statusCode && s.statusCode < 400);

  const hasIssues = downServers.length > 0 || unhealthyServers.length > 0;
  const criticalChanges = changes.filter(c => c.changeType === 'critical');
  const degradedChanges = changes.filter(c => c.changeType === 'degraded');

  const autoCheckerDown = downServers.some(s =>
    AUTOCHECKER_ALERT_IPS.some(ip => s.url.includes(ip))
  );

  let subject = '';
  if (autoCheckerDown) {
    subject = 'Auto Checker Server Down';
  } else if (criticalChanges.length > 0) {
    subject = `🚨 CRITICAL: ${criticalChanges.length} Server(s) Down!`;
  } else if (degradedChanges.length > 0) {
    subject = `⚠️ WARNING: ${degradedChanges.length} Server(s) Degraded`;
  } else if (changes.length > 0) {
    subject = `✅ Server Status Improved: ${changes.length} Change(s)`;
  } else if (hasIssues) {
    subject = `🚨 Server Alert: ${downServers.length} Down, ${unhealthyServers.length} Unhealthy`;
  } else {
    subject = `✅ All Servers Healthy (${healthyServers.length} servers)`;
  }

  const INK = '#0f172a';
  const INK_SOFT = '#64748b';
  const LINE = '#e2e8f0';
  const GOOD = '#16a34a';
  const GOOD_BG = '#ecfdf3';
  const WARN = '#d97706';
  const WARN_BG = '#fffbeb';
  const BAD = '#dc2626';
  const BAD_BG = '#fef2f2';

  const pill = (label: string, color: string, bg: string) =>
    `<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:${color};background:${bg};">${label}</span>`;

  const generateServerRows = (servers: ServerStatus[], statusLabel: string, color: string, bg: string) => {
    return servers.map(s => `
              <tr>
                <td style="padding:13px 16px;border-bottom:1px solid ${LINE};">
                  <div style="font-weight:600;color:${INK};font-size:13.5px;">${escapeHtml(s.name || 'Unknown')}</div>
                  <div style="font-size:12px;color:${INK_SOFT};font-family:Consolas,monospace;margin-top:2px;">${escapeHtml(s.url)}</div>
                </td>
                <td style="padding:13px 16px;border-bottom:1px solid ${LINE};">${pill(statusLabel, color, bg)}</td>
                <td style="padding:13px 16px;border-bottom:1px solid ${LINE};color:${INK_SOFT};font-family:Consolas,monospace;font-size:12.5px;">
                  ${s.isActive ? escapeHtml(`${s.statusCode} ${s.statusText}`) : escapeHtml(s.error || 'No response')}
                </td>
                <td style="padding:13px 16px;border-bottom:1px solid ${LINE};color:${INK_SOFT};font-family:Consolas,monospace;font-size:12.5px;text-align:right;">
                  ${s.responseTime ? `${s.responseTime} ms` : '—'}
                </td>
              </tr>`).join('');
  };

  const tableSection = (title: string, servers: ServerStatus[], statusLabel: string, dotColor: string, color: string, bg: string) => {
    if (servers.length === 0) return '';
    return `
        <tr>
          <td style="padding:0 32px 8px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
              <tr>
                <td style="font-size:15px;font-weight:600;color:${INK};padding-bottom:12px;">
                  <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${dotColor};margin-right:8px;"></span>${title}
                  <span style="font-size:12px;color:${INK_SOFT};font-weight:400;margin-left:6px;">(${servers.length})</span>
                </td>
              </tr>
              <tr>
                <td>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${LINE};border-radius:10px;overflow:hidden;">
                    <tr>
                      <th align="left" style="padding:12px 16px;font-size:11.5px;text-transform:uppercase;letter-spacing:0.04em;color:${INK_SOFT};border-bottom:1px solid ${LINE};">Server</th>
                      <th align="left" style="padding:12px 16px;font-size:11.5px;text-transform:uppercase;letter-spacing:0.04em;color:${INK_SOFT};border-bottom:1px solid ${LINE};">Status</th>
                      <th align="left" style="padding:12px 16px;font-size:11.5px;text-transform:uppercase;letter-spacing:0.04em;color:${INK_SOFT};border-bottom:1px solid ${LINE};">Detail</th>
                      <th align="right" style="padding:12px 16px;font-size:11.5px;text-transform:uppercase;letter-spacing:0.04em;color:${INK_SOFT};border-bottom:1px solid ${LINE};">Latency</th>
                    </tr>
                    ${generateServerRows(servers, statusLabel, color, bg)}
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
  };

  const htmlContent = `
    <html>
      <body style="margin:0;padding:0;background:#f6f8fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fb;padding:32px 0;">
          <tr>
            <td align="center">
              <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${LINE};border-radius:12px;overflow:hidden;">
                <tr>
                  <td style="padding:28px 32px 20px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td>
                          <table role="presentation" cellpadding="0" cellspacing="0">
                            <tr>
                              <td style="width:36px;height:36px;background:#2563eb;border-radius:8px;text-align:center;vertical-align:middle;color:#ffffff;font-weight:700;font-size:15px;">AH</td>
                              <td style="padding-left:12px;">
                                <div style="font-size:15px;font-weight:600;color:${INK};">Adhash Technologies</div>
                                <div style="font-size:12.5px;color:${INK_SOFT};">Server Health Monitor</div>
                              </td>
                            </tr>
                          </table>
                        </td>
                        <td align="right">
                          <span style="display:inline-block;padding:7px 14px;border-radius:999px;font-size:13px;font-weight:600;color:${hasIssues ? BAD : GOOD};background:${hasIssues ? BAD_BG : GOOD_BG};">${hasIssues ? 'Issues Detected' : 'All Systems Operational'}</span>
                        </td>
                      </tr>
                    </table>
                    <div style="font-size:13px;color:${INK_SOFT};margin-top:18px;">
                      ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} · Monitoring ${statuses.length} server(s)
                    </div>
                  </td>
                </tr>

                <tr>
                  <td style="padding:0 32px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="25%" style="padding:6px;">
                          <div style="border:1px solid ${LINE};border-radius:10px;padding:16px;">
                            <div style="font-size:11.5px;color:${INK_SOFT};text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">Healthy</div>
                            <div style="font-size:26px;font-weight:700;color:${GOOD};">${healthyServers.length}</div>
                          </div>
                        </td>
                        <td width="25%" style="padding:6px;">
                          <div style="border:1px solid ${LINE};border-radius:10px;padding:16px;">
                            <div style="font-size:11.5px;color:${INK_SOFT};text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">Unhealthy</div>
                            <div style="font-size:26px;font-weight:700;color:${WARN};">${unhealthyServers.length}</div>
                          </div>
                        </td>
                        <td width="25%" style="padding:6px;">
                          <div style="border:1px solid ${LINE};border-radius:10px;padding:16px;">
                            <div style="font-size:11.5px;color:${INK_SOFT};text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">Down</div>
                            <div style="font-size:26px;font-weight:700;color:${BAD};">${downServers.length}</div>
                          </div>
                        </td>
                        <td width="25%" style="padding:6px;">
                          <div style="border:1px solid ${LINE};border-radius:10px;padding:16px;">
                            <div style="font-size:11.5px;color:${INK_SOFT};text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">Total</div>
                            <div style="font-size:26px;font-weight:700;color:${INK};">${statuses.length}</div>
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                ${changes.length > 0 ? `
                <tr>
                  <td style="padding:20px 32px 0;">
                    <div style="background:${criticalChanges.length > 0 ? BAD_BG : degradedChanges.length > 0 ? WARN_BG : GOOD_BG};border-left:4px solid ${criticalChanges.length > 0 ? BAD : degradedChanges.length > 0 ? WARN : GOOD};border-radius:8px;padding:16px 18px;">
                      <div style="font-size:13.5px;font-weight:600;color:${criticalChanges.length > 0 ? BAD : degradedChanges.length > 0 ? WARN : GOOD};margin-bottom:10px;">Status Changes Detected (${changes.length})</div>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        ${changes.map(change => `
                        <tr>
                          <td style="padding:6px 0;font-size:13px;font-weight:600;color:${INK};">${escapeHtml(change.name)}</td>
                          <td style="padding:6px 0;font-size:12.5px;color:${INK_SOFT};">
                            ${change.previousStatus} → <strong style="color:${change.currentStatus === 'down' ? BAD : change.currentStatus === 'unhealthy' ? WARN : GOOD};">${change.currentStatus}</strong>
                          </td>
                          <td style="padding:6px 0;font-size:12px;color:${INK_SOFT};text-align:right;">
                            ${change.changeType === 'critical' ? 'CRITICAL' : change.changeType === 'degraded' ? 'DEGRADED' : 'IMPROVED'}
                          </td>
                        </tr>`).join('')}
                      </table>
                    </div>
                  </td>
                </tr>` : ''}

                <tr><td style="padding:0 32px;"><table role="presentation" width="100%"><tr>
                  ${tableSection('Down / Inactive', downServers, 'DOWN', BAD, BAD, BAD_BG)}
                  ${tableSection('Unhealthy', unhealthyServers, 'UNHEALTHY', WARN, WARN, WARN_BG)}
                  ${tableSection('Healthy', healthyServers, 'HEALTHY', GOOD, GOOD, GOOD_BG)}
                </tr></table></td></tr>

                <tr>
                  <td style="padding:24px 32px 28px;">
                    <div style="border-top:1px solid ${LINE};padding-top:16px;font-size:12.5px;color:${INK_SOFT};">
                      Automated report · Server Health Monitor · Questions: <a href="mailto:qateam@adhashtech.com" style="color:#2563eb;text-decoration:none;">qateam@adhashtech.com</a>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  const mailOptions = {
    from: config.user,
    to: config.to,
    subject: subject,
    html: htmlContent,
    attachments: [
      {
        filename: report.reportFileName,
        path: report.reportPath,
        contentType: 'text/html'
      }
    ]
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`   📧 Email alert sent to: ${config.to}`);
    console.log(`   📎 Attached: ${report.reportFileName}`);
    return true;
  } catch (error: any) {
    console.log(`   ❌ Failed to send email: ${error.message}`);
    return false;
  }
}

async function checkServerHealth(url: string, customName?: string): Promise<ServerStatus> {
  const context = await request.newContext();
  const serverName = customName || extractServerName(url);

  try {
    const startTime = Date.now();

    const response = await context.get(url, {
      timeout: 10000,
      ignoreHTTPSErrors: true
    });

    const endTime = Date.now();
    const responseTime = endTime - startTime;
    const status = response.status();
    const statusText = response.statusText();

    await context.dispose();

    return {
      url,
      name: serverName,
      isActive: true,
      statusCode: status,
      statusText: statusText,
      responseTime: responseTime,
      timestamp: new Date()
    };

  } catch (error: any) {
    await context.dispose();

    return {
      url,
      name: serverName,
      isActive: false,
      error: error.message,
      timestamp: new Date()
    };
  }
}

async function main() {
  const emailConfig: EmailConfig = {
    service: process.env.EMAIL_SERVICE,
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT) : undefined,
    secure: process.env.EMAIL_SECURE === 'true',
    user: process.env.EMAIL_USER || '',
    password: process.env.EMAIL_PASSWORD || '',
    to: process.env.EMAIL_TO || '',
  };

  const serverUrlsString = process.env.SERVER_URLS || 'http://20.7.146.191:3000/,https://20.1.198.58/,https://www.ddphub.ai/|DDP URL,https://twfnwlccyudfgqjmmdva.supabase.co/|DDP API';
  const requiredServerUrlsString = process.env.REQUIRED_SERVER_URLS || '';
  const configuredServerEntries = parseServerEntries(serverUrlsString);
  const requiredServerEntries = parseServerEntries(requiredServerUrlsString);
  const { entries: serverEntries, addedRequiredServerCount } = mergeServerEntries(configuredServerEntries, requiredServerEntries);

  if (addedRequiredServerCount > 0) {
    console.log(`🛡️ Required server safeguard: ${addedRequiredServerCount} required server(s) not in configured list were auto-added`);
  }

  const sendOnlyOnChange = process.env.SEND_ONLY_ON_CHANGE === 'true';

  if (!emailConfig.user || !emailConfig.password || !emailConfig.to) {
    console.warn('⚠️  Warning: Email configuration is missing!');
    console.warn('   Email notifications will be disabled.');
    console.warn('   To enable email alerts, create a .env file with EMAIL_USER, EMAIL_PASSWORD, and EMAIL_TO');
    console.log('');
  } else {
    console.log('📧 Email Configuration:');
    console.log(`   From: ${emailConfig.user}`);
    console.log(`   To: ${emailConfig.to}`);
    console.log(`   SMTP: ${emailConfig.host || emailConfig.service}`);
    console.log(`   Mode: ${sendOnlyOnChange ? 'Send only on status change' : 'Send every check'}`);
    console.log('');
  }

  // Load previous status
  const previousStatusMap = loadPreviousStatus();
  console.log('');

  console.log(`🔍 Checking ${serverEntries.length} server(s)...\n`);

  const statuses: ServerStatus[] = [];

  for (const entry of serverEntries) {
    const displayName = entry.name || entry.url;
    console.log(`Checking: ${displayName}`);
    const status = await checkServerHealth(entry.url, entry.name);

    if (status.isActive) {
      if (status.statusCode && status.statusCode >= 200 && status.statusCode < 400) {
        console.log(`   ✅ HEALTHY - ${status.statusCode} ${status.statusText} (${status.responseTime}ms)`);
      } else {
        console.log(`   ⚠️ UNHEALTHY - ${status.statusCode} ${status.statusText} (${status.responseTime}ms)`);
      }
    } else {
      console.log(`   🚨 DOWN - ${status.error}`);
    }

    statuses.push(status);
  }

  console.log('\n📊 Summary:');
  const healthy = statuses.filter(s => s.isActive && s.statusCode && s.statusCode < 400).length;
  const unhealthy = statuses.filter(s => s.isActive && s.statusCode && s.statusCode >= 400).length;
  const down = statuses.filter(s => !s.isActive).length;

  console.log(`   ✅ Healthy: ${healthy}`);
  console.log(`   ⚠️ Unhealthy: ${unhealthy}`);
  console.log(`   🚨 Down: ${down}`);
  console.log('');

  // Detect status changes
  const changes = detectStatusChanges(statuses, previousStatusMap);

  if (changes.length > 0) {
    console.log('🔔 Status Changes Detected:');
    changes.forEach(change => {
      const icon = change.changeType === 'critical' ? '🚨' : change.changeType === 'degraded' ? '⚠️' : '✅';
      console.log(`   ${icon} ${change.name}: ${change.previousStatus} → ${change.currentStatus}`);
    });
    console.log('');
  } else {
    console.log('✓ No status changes detected\n');
  }

  // Save current status for next run
  savePreviousStatus(statuses);
  console.log('');

  // Generate the HTML report once so Slack and email can both reference it
  const report = saveHTMLReport(statuses);
  const reportBaseUrl = (process.env.REPORT_BASE_URL || '').trimEnd();
  const reportBaseUrlTrimmed = reportBaseUrl.endsWith('/') ? reportBaseUrl.slice(0, -1) : reportBaseUrl;
  const reportUrl = reportBaseUrlTrimmed ? `${reportBaseUrlTrimmed}/latest.html` : undefined;

  const slackBotToken = process.env.SLACK_BOT_TOKEN || '';
  const slackChannel = process.env.SLACK_CHANNEL || '';
  const slackConfigured = Boolean(slackBotToken && slackChannel);

  if (!slackConfigured) {
    console.warn('⚠️  SLACK_BOT_TOKEN / SLACK_CHANNEL is not configured - skipping Slack notifications');
  }

  // Immediate Slack alert when either monitored AutoChecker server goes down
  const newlyDownAutoCheckerServers = statuses.filter(s =>
    !s.isActive &&
    AUTOCHECKER_ALERT_IPS.some(ip => s.url.includes(ip)) &&
    changes.some(c => c.url === s.url && c.currentStatus === 'down')
  );

  if (newlyDownAutoCheckerServers.length > 0 && slackConfigured) {
    console.log('💬 Sending Slack alert for AutoChecker server(s) down...');
    await sendSlackAutoCheckerDownAlert(slackBotToken, slackChannel, newlyDownAutoCheckerServers, reportUrl);
  }

  // Full status report posted to Slack alongside the email report
  if (slackConfigured) {
    console.log('💬 Sending Slack health report...');
    await sendSlackHealthReport(slackBotToken, slackChannel, statuses, reportUrl);
  }

  // Send email based on mode
  let shouldSendEmail = true;

  if (sendOnlyOnChange) {
    shouldSendEmail = changes.length > 0;
    if (!shouldSendEmail) {
      console.log('📧 No status changes - skipping email (send-only-on-change mode)');
      console.log('✨ Check completed successfully!\n');
      return;
    }
  }

  console.log('📧 Sending email report...');
  const emailSent = await sendMultiServerEmail(emailConfig, statuses, report, changes);

  if (emailSent) {
    console.log('✨ Email sent successfully!\n');
  } else {
    console.log('❌ Failed to send email\n');
  }
}

main();
