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

  const generateServerCards = (servers: ServerStatus[], statusColor: string, statusLabel: string, icon: string) => {
    return servers.map(s => `
      <div class="server-card ${statusLabel.toLowerCase()}">
        <div class="server-header">
          <span class="server-icon">${icon}</span>
          <div class="server-info">
            <div class="server-name">${s.name || 'Unknown'}</div>
            <div class="server-url">${s.url}</div>
          </div>
        </div>
        <div class="server-details">
          <div class="detail-item">
            <span class="detail-label">Name:</span>
            <span class="detail-value" style="font-weight: bold; color: #333;">${s.name || 'Unknown'}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Status:</span>
            <span class="detail-value" style="color: ${statusColor}; font-weight: bold;">${statusLabel}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Response:</span>
            <span class="detail-value">${s.isActive ? `${s.statusCode} ${s.statusText}` : s.error || 'No response'}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Response Time:</span>
            <span class="detail-value">${s.responseTime ? `${s.responseTime}ms` : 'N/A'}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Checked:</span>
            <span class="detail-value">${s.timestamp.toLocaleTimeString()}</span>
          </div>
        </div>
      </div>
    `).join('');
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Server Health Report - ${new Date().toLocaleDateString()}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #FFD6A5 0%, #CAFFBF 100%);
      padding: 20px;
      min-height: 100vh;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }

    .header {
      background: ${hasIssues ? 'linear-gradient(135deg, #f44336 0%, #e91e63 100%)' : 'linear-gradient(135deg, #4caf50 0%, #8bc34a 100%)'};
      color: white;
      padding: 40px;
      text-align: center;
    }

    .header h1 {
      font-size: 2.5em;
      margin-bottom: 10px;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
    }

    .header .subtitle {
      font-size: 1.1em;
      opacity: 0.95;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      padding: 40px;
      background: #f8f9fa;
    }

    .summary-card {
      background: white;
      padding: 30px;
      border-radius: 15px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      text-align: center;
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }

    .summary-card:hover {
      transform: translateY(-5px);
      box-shadow: 0 8px 12px rgba(0,0,0,0.15);
    }

    .summary-card .icon {
      font-size: 3em;
      margin-bottom: 15px;
    }

    .summary-card .label {
      font-size: 0.9em;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 10px;
    }

    .summary-card .count {
      font-size: 3em;
      font-weight: bold;
      margin-bottom: 5px;
    }

    .summary-card.healthy .count { color: #4caf50; }
    .summary-card.unhealthy .count { color: #ff9800; }
    .summary-card.down .count { color: #f44336; }

    .content {
      padding: 40px;
    }

    .section {
      margin-bottom: 40px;
    }

    .section-title {
      font-size: 1.8em;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 3px solid #e0e0e0;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .section-title.healthy { border-color: #4caf50; color: #4caf50; }
    .section-title.unhealthy { border-color: #ff9800; color: #ff9800; }
    .section-title.down { border-color: #f44336; color: #f44336; }

    .servers-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
      gap: 20px;
    }

    .server-card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      border-left: 5px solid;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .server-card:hover {
      transform: translateX(5px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }

    .server-card.active { border-color: #4caf50; }
    .server-card.unhealthy { border-color: #ff9800; }
    .server-card.inactive { border-color: #f44336; }

    .server-header {
      display: flex;
      align-items: flex-start;
      gap: 15px;
      margin-bottom: 15px;
      padding-bottom: 15px;
      border-bottom: 2px solid #e0e0e0;
    }

    .server-icon {
      font-size: 2em;
      flex-shrink: 0;
    }

    .server-info {
      flex: 1;
    }

    .server-name {
      font-size: 1.3em;
      font-weight: 700;
      color: #1a1a1a;
      margin-bottom: 5px;
      text-transform: capitalize;
    }

    .server-url {
      font-size: 0.85em;
      color: #666;
      word-break: break-all;
      font-family: 'Courier New', monospace;
    }

    .server-details {
      display: grid;
      gap: 10px;
    }

    .detail-item {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
    }

    .detail-label {
      color: #666;
      font-size: 0.9em;
    }

    .detail-value {
      color: #333;
      font-weight: 500;
    }

    .footer {
      background: #2c3e50;
      color: white;
      padding: 30px;
      text-align: center;
    }

    .footer p {
      margin: 5px 0;
      opacity: 0.9;
    }

    .timestamp {
      background: #ecf0f1;
      padding: 15px;
      border-radius: 8px;
      margin: 20px 0;
      text-align: center;
      font-size: 0.95em;
      color: #555;
    }

    @media (max-width: 768px) {
      .servers-grid {
        grid-template-columns: 1fr;
      }

      .header h1 {
        font-size: 1.8em;
      }

      .summary {
        grid-template-columns: 1fr;
      }
    }

    @media print {
      body {
        background: white;
        padding: 0;
      }

      .container {
        box-shadow: none;
      }

      .server-card:hover {
        transform: none;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${hasIssues ? '🚨 Server Status Alert' : '✅ Server Health Report'}</h1>
      <p class="subtitle">Automated Server Monitoring System</p>
    </div>

    <div class="timestamp">
      <strong>📅 Report Generated:</strong> ${timestamp}
    </div>

    <div class="summary">
      <div class="summary-card healthy">
        <div class="icon">✅</div>
        <div class="label">Healthy Servers</div>
        <div class="count">${healthyServers.length}</div>
        <div style="color: #666; font-size: 0.9em;">Working Perfectly</div>
      </div>

      <div class="summary-card unhealthy">
        <div class="icon">⚠️</div>
        <div class="label">Unhealthy Servers</div>
        <div class="count">${unhealthyServers.length}</div>
        <div style="color: #666; font-size: 0.9em;">Active but Errors</div>
      </div>

      <div class="summary-card down">
        <div class="icon">🚨</div>
        <div class="label">Down Servers</div>
        <div class="count">${downServers.length}</div>
        <div style="color: #666; font-size: 0.9em;">Not Responding</div>
      </div>

      <div class="summary-card" style="background: linear-gradient(135deg, #A8DADC 0%, #457B9D 100%); color: white;">
        <div class="icon">🖥️</div>
        <div class="label" style="color: white; opacity: 0.9;">Total Servers</div>
        <div class="count" style="color: white;">${statuses.length}</div>
        <div style="opacity: 0.9; font-size: 0.9em;">Being Monitored</div>
      </div>
    </div>

    <div class="content">
      ${downServers.length > 0 ? `
      <div class="section">
        <h2 class="section-title down">🚨 Down/Inactive Servers (${downServers.length})</h2>
        <div class="servers-grid">
          ${generateServerCards(downServers, '#f44336', 'INACTIVE', '🚨')}
        </div>
      </div>
      ` : ''}

      ${unhealthyServers.length > 0 ? `
      <div class="section">
        <h2 class="section-title unhealthy">⚠️ Unhealthy Servers (${unhealthyServers.length})</h2>
        <div class="servers-grid">
          ${generateServerCards(unhealthyServers, '#ff9800', 'ACTIVE', '⚠️')}
        </div>
      </div>
      ` : ''}

      ${healthyServers.length > 0 ? `
      <div class="section">
        <h2 class="section-title healthy">✅ Healthy Servers (${healthyServers.length})</h2>
        <div class="servers-grid">
          ${generateServerCards(healthyServers, '#4caf50', 'ACTIVE', '✅')}
        </div>
      </div>
      ` : ''}
    </div>

    <div class="footer">
      <p><strong>Adhash Technologies - Server Monitoring System</strong></p>
      <p>This is an automated report generated by the Server Health Monitor</p>
      <p>Monitoring ${statuses.length} server(s) • Report ID: ${Date.now()}</p>
      <p style="margin-top: 15px; font-size: 0.9em;">
        For questions or issues, contact: <a href="mailto:qateam@adhashtech.com" style="color: #3498db;">qateam@adhashtech.com</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

const AUTOCHECKER_ALERT_IPS = ['20.7.146.191', '20.15.121.70'];

async function sendSlackAutoCheckerDownAlert(webhookUrl: string, downServers: ServerStatus[]): Promise<boolean> {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });

  const serverLines = downServers
    .map(s => `• *${s.name || s.url}* (${s.url}) — ${s.error || 'No response'}`)
    .join('\n');

  const payload = {
    text: `🔴 *AutoChecker Scrap Server Down*\n*Timestamp:* ${timestamp}\n${serverLines}`,
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.log(`   ❌ Slack webhook returned ${response.status}`);
      return false;
    }

    console.log('   💬 Slack alert sent: AutoChecker Scrap Server Down');
    return true;
  } catch (error: any) {
    console.log(`   ❌ Failed to send Slack alert: ${error.message}`);
    return false;
  }
}

async function sendMultiServerEmail(config: EmailConfig, statuses: ServerStatus[], changes: StatusChange[] = []) {
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

  const generateServerRows = (servers: ServerStatus[], statusColor: string, statusLabel: string) => {
    return servers.map(s => `
      <tr style="border-bottom: 1px solid #e0e0e0;">
        <td style="padding: 12px 8px; color: #333;">${s.url}</td>
        <td style="padding: 12px 8px; color: ${statusColor}; font-weight: bold;">${statusLabel}</td>
        <td style="padding: 12px 8px; color: #666;">
          ${s.isActive ? `${s.statusCode} ${s.statusText}` : s.error || 'No response'}
        </td>
        <td style="padding: 12px 8px; color: #666;">
          ${s.responseTime ? `${s.responseTime}ms` : 'N/A'}
        </td>
      </tr>
    `).join('');
  };

  const htmlContent = `
    <html>
      <body style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
        <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h2 style="color: ${hasIssues ? '#f44336' : '#4caf50'}; margin-top: 0;">
            ${hasIssues ? '🚨 Server Status Alert' : '✅ Server Health Report'}
          </h2>

          <p style="color: #666; margin-bottom: 20px;">
            <strong>Timestamp:</strong> ${new Date().toLocaleString()}<br>
            <strong>Total Servers Monitored:</strong> ${statuses.length}
          </p>

          ${changes.length > 0 ? `
          <div style="background-color: ${criticalChanges.length > 0 ? '#ffebee' : degradedChanges.length > 0 ? '#fff3e0' : '#e8f5e9'}; padding: 20px; border-radius: 5px; margin: 20px 0; border-left: 5px solid ${criticalChanges.length > 0 ? '#f44336' : degradedChanges.length > 0 ? '#ff9800' : '#4caf50'};">
            <h3 style="margin-top: 0; color: ${criticalChanges.length > 0 ? '#f44336' : degradedChanges.length > 0 ? '#ff9800' : '#4caf50'};">
              🔔 Status Changes Detected (${changes.length})
            </h3>
            <table style="width: 100%; border-collapse: collapse;">
              ${changes.map(change => `
                <tr style="border-bottom: 1px solid #e0e0e0;">
                  <td style="padding: 12px 8px; color: #333; font-weight: bold;">${change.name}</td>
                  <td style="padding: 12px 8px; color: #666;">
                    <span style="background-color: #f5f5f5; padding: 4px 8px; border-radius: 3px;">${change.previousStatus}</span>
                    →
                    <span style="background-color: ${change.currentStatus === 'down' ? '#f44336' : change.currentStatus === 'unhealthy' ? '#ff9800' : '#4caf50'}; color: white; padding: 4px 8px; border-radius: 3px;">${change.currentStatus}</span>
                  </td>
                  <td style="padding: 12px 8px; text-align: right;">
                    ${change.changeType === 'critical' ? '🚨 CRITICAL' : change.changeType === 'degraded' ? '⚠️ DEGRADED' : '✅ IMPROVED'}
                  </td>
                </tr>
              `).join('')}
            </table>
          </div>
          ` : ''}

          <div style="background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #333;">Summary</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #666; width: 200px;">✅ Healthy Servers:</td>
                <td style="padding: 8px 0; color: #4caf50; font-weight: bold; font-size: 18px;">${healthyServers.length}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">⚠️ Unhealthy Servers:</td>
                <td style="padding: 8px 0; color: #ff9800; font-weight: bold; font-size: 18px;">${unhealthyServers.length}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">🚨 Down/Inactive Servers:</td>
                <td style="padding: 8px 0; color: #f44336; font-weight: bold; font-size: 18px;">${downServers.length}</td>
              </tr>
            </table>
          </div>

          ${downServers.length > 0 ? `
          <div style="margin: 20px 0;">
            <h3 style="color: #f44336; margin-bottom: 10px;">🚨 Down/Inactive Servers</h3>
            <table style="width: 100%; border-collapse: collapse; background-color: #fff;">
              <thead>
                <tr style="background-color: #f44336; color: white;">
                  <th style="padding: 12px 8px; text-align: left;">Server Address</th>
                  <th style="padding: 12px 8px; text-align: left;">Status</th>
                  <th style="padding: 12px 8px; text-align: left;">Error</th>
                  <th style="padding: 12px 8px; text-align: left;">Response Time</th>
                </tr>
              </thead>
              <tbody>
                ${generateServerRows(downServers, '#f44336', 'INACTIVE')}
              </tbody>
            </table>
          </div>
          ` : ''}

          ${unhealthyServers.length > 0 ? `
          <div style="margin: 20px 0;">
            <h3 style="color: #ff9800; margin-bottom: 10px;">⚠️ Unhealthy Servers</h3>
            <table style="width: 100%; border-collapse: collapse; background-color: #fff;">
              <thead>
                <tr style="background-color: #ff9800; color: white;">
                  <th style="padding: 12px 8px; text-align: left;">Server Address</th>
                  <th style="padding: 12px 8px; text-align: left;">Status</th>
                  <th style="padding: 12px 8px; text-align: left;">Status Code</th>
                  <th style="padding: 12px 8px; text-align: left;">Response Time</th>
                </tr>
              </thead>
              <tbody>
                ${generateServerRows(unhealthyServers, '#ff9800', 'ACTIVE')}
              </tbody>
            </table>
          </div>
          ` : ''}

          ${healthyServers.length > 0 ? `
          <div style="margin: 20px 0;">
            <h3 style="color: #4caf50; margin-bottom: 10px;">✅ Healthy Servers</h3>
            <table style="width: 100%; border-collapse: collapse; background-color: #fff;">
              <thead>
                <tr style="background-color: #4caf50; color: white;">
                  <th style="padding: 12px 8px; text-align: left;">Server Address</th>
                  <th style="padding: 12px 8px; text-align: left;">Status</th>
                  <th style="padding: 12px 8px; text-align: left;">Status Code</th>
                  <th style="padding: 12px 8px; text-align: left;">Response Time</th>
                </tr>
              </thead>
              <tbody>
                ${generateServerRows(healthyServers, '#4caf50', 'ACTIVE')}
              </tbody>
            </table>
          </div>
          ` : ''}


          <hr style="margin: 20px 0; border: none; border-top: 1px solid #e0e0e0;">
          <p style="color: #999; font-size: 12px; margin-bottom: 0;">
            This is an automated alert from your Server Health Monitor.<br>
            Monitoring ${statuses.length} server(s)
          </p>
        </div>
      </body>
    </html>
  `;

  // Generate modern HTML report
  const modernReport = generateModernHTMLReport(statuses);
  const reportFileName = `server-health-report-${new Date().toISOString().split('T')[0]}.html`;
  const reportPath = path.join(process.cwd(), 'reports', reportFileName);

  // Create reports directory if it doesn't exist
  const reportsDir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // Save the HTML report to file
  fs.writeFileSync(reportPath, modernReport, 'utf-8');
  console.log(`   📄 HTML report saved: ${reportPath}`);

  const mailOptions = {
    from: config.user,
    to: config.to,
    subject: subject,
    html: htmlContent,
    attachments: [
      {
        filename: reportFileName,
        path: reportPath,
        contentType: 'text/html'
      }
    ]
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`   📧 Email alert sent to: ${config.to}`);
    console.log(`   📎 Attached: ${reportFileName}`);
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

  // Immediate Slack alert when either monitored AutoChecker server goes down
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || '';
  const newlyDownAutoCheckerServers = statuses.filter(s =>
    !s.isActive &&
    AUTOCHECKER_ALERT_IPS.some(ip => s.url.includes(ip)) &&
    changes.some(c => c.url === s.url && c.currentStatus === 'down')
  );

  if (newlyDownAutoCheckerServers.length > 0) {
    if (slackWebhookUrl) {
      console.log('💬 Sending Slack alert for AutoChecker server(s) down...');
      await sendSlackAutoCheckerDownAlert(slackWebhookUrl, newlyDownAutoCheckerServers);
    } else {
      console.warn('⚠️  SLACK_WEBHOOK_URL is not configured - skipping Slack alert');
    }
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
  const emailSent = await sendMultiServerEmail(emailConfig, statuses, changes);

  if (emailSent) {
    console.log('✨ Email sent successfully!\n');
  } else {
    console.log('❌ Failed to send email\n');
  }
}

main();
