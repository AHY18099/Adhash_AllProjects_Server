import { request } from '@playwright/test';
import nodemailer from 'nodemailer';
import * as dotenv from 'dotenv';

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
  isActive: boolean;
  statusCode?: number;
  statusText?: string;
  responseTime?: number;
  error?: string;
  timestamp: Date;
}

// Track last known status for each server
const serverStatusHistory: Map<string, 'healthy' | 'unhealthy' | 'down'> = new Map();

async function sendServerDownEmail(config: EmailConfig, server: ServerStatus) {
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

  const autoCheckerIps = ['20.7.146.191', '20.1.198.58'];
  const isAutoChecker = autoCheckerIps.some(ip => server.url.includes(ip));
  const subject = server.isActive
    ? `⚠️ Server Unhealthy Alert - ${server.url}`
    : isAutoChecker
      ? 'Auto Checker Server Down'
      : `🚨 Server DOWN Alert - ${server.url}`;

  const statusText = server.isActive ? 'ACTIVE' : 'INACTIVE';
  const statusColor = server.isActive ? '#ff9800' : '#f44336';
  const statusIcon = server.isActive ? '⚠️' : '🚨';

  const htmlContent = `
    <html>
      <body style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
        <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h2 style="color: ${statusColor}; margin-top: 0;">
            ${statusIcon} Server Status Changed
          </h2>

          <div style="background-color: ${server.isActive ? '#fff3e0' : '#ffebee'}; padding: 20px; border-radius: 5px; margin: 20px 0; border-left: 4px solid ${statusColor};">
            <h3 style="margin-top: 0; color: #333;">Alert Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #666; width: 150px;"><strong>Server Address:</strong></td>
                <td style="padding: 8px 0; color: #333; font-size: 16px;">${server.url}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Status:</strong></td>
                <td style="padding: 8px 0; color: ${statusColor}; font-weight: bold; font-size: 18px;">${statusText}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Timestamp:</strong></td>
                <td style="padding: 8px 0; color: #333;">${server.timestamp.toLocaleString()}</td>
              </tr>
              ${server.isActive ? `
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Status Code:</strong></td>
                <td style="padding: 8px 0; color: #333;">${server.statusCode} ${server.statusText}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Response Time:</strong></td>
                <td style="padding: 8px 0; color: #333;">${server.responseTime}ms</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Issue:</strong></td>
                <td style="padding: 8px 0; color: #ff9800;">Server returned error status code</td>
              </tr>
              ` : `
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Error:</strong></td>
                <td style="padding: 8px 0; color: #f44336;">${server.error}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Issue:</strong></td>
                <td style="padding: 8px 0; color: #f44336;">Server is not responding or unreachable</td>
              </tr>
              `}
            </table>
          </div>

          <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 0; color: #666;">
              <strong>Action Required:</strong><br>
              ${server.isActive
                ? 'The server is responding but returning error codes. Please investigate the application.'
                : 'The server is not responding. Please check if the server is running and network connectivity.'}
            </p>
          </div>

          <hr style="margin: 20px 0; border: none; border-top: 1px solid #e0e0e0;">
          <p style="color: #999; font-size: 12px; margin-bottom: 0;">
            This is an automated alert from your Server Health Monitor.<br>
            You are receiving this because the server status changed from active to ${server.isActive ? 'unhealthy' : 'down'}.
          </p>
        </div>
      </body>
    </html>
  `;

  const mailOptions = {
    from: config.user,
    to: config.to,
    subject: subject,
    html: htmlContent,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`   📧 Email alert sent to: ${config.to}`);
    return true;
  } catch (error: any) {
    console.log(`   ❌ Failed to send email: ${error.message}`);
    return false;
  }
}

async function checkServerHealth(url: string): Promise<ServerStatus> {
  const context = await request.newContext();

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
      isActive: false,
      error: error.message,
      timestamp: new Date()
    };
  }
}

async function monitorServers(serverUrls: string[], emailConfig: EmailConfig, checkInterval: number) {
  console.log('🚀 Multi-Server Monitor Started');
  console.log(`   Servers: ${serverUrls.length}`);
  console.log(`   Check Interval: ${checkInterval / 60000} minutes`);
  console.log(`   Email From: ${emailConfig.user}`);
  console.log(`   Email To: ${emailConfig.to}`);
  console.log(`   SMTP: ${emailConfig.host || emailConfig.service}`);
  console.log('   Press Ctrl+C to stop\n');
  console.log('📋 Monitoring servers:');
  serverUrls.forEach((url, index) => {
    console.log(`   ${index + 1}. ${url}`);
  });
  console.log('\n' + '='.repeat(80) + '\n');

  const checkAllServers = async () => {
    console.log(`🔍 Health Check - ${new Date().toLocaleString()}\n`);

    for (const url of serverUrls) {
      const status = await checkServerHealth(url);

      let currentStatus: 'healthy' | 'unhealthy' | 'down';

      if (!status.isActive) {
        currentStatus = 'down';
      } else if (status.statusCode && status.statusCode >= 400) {
        currentStatus = 'unhealthy';
      } else {
        currentStatus = 'healthy';
      }

      const previousStatus = serverStatusHistory.get(url);

      // Display current status
      if (currentStatus === 'healthy') {
        console.log(`✅ ${url}`);
        console.log(`   Status: HEALTHY - ${status.statusCode} ${status.statusText} (${status.responseTime}ms)`);
      } else if (currentStatus === 'unhealthy') {
        console.log(`⚠️ ${url}`);
        console.log(`   Status: UNHEALTHY - ${status.statusCode} ${status.statusText} (${status.responseTime}ms)`);
      } else {
        console.log(`🚨 ${url}`);
        console.log(`   Status: DOWN - ${status.error}`);
      }

      // Check if status changed from healthy/unhealthy to down, or from healthy to unhealthy
      const shouldSendEmail =
        (previousStatus === 'healthy' && currentStatus === 'down') ||
        (previousStatus === 'unhealthy' && currentStatus === 'down') ||
        (previousStatus === 'healthy' && currentStatus === 'unhealthy') ||
        (previousStatus === null && currentStatus !== 'healthy'); // First check and not healthy

      if (shouldSendEmail) {
        console.log(`   🔔 Status changed: ${previousStatus || 'unknown'} → ${currentStatus}`);
        console.log(`   📧 Sending email alert...`);
        await sendServerDownEmail(emailConfig, status);
      } else if (previousStatus !== currentStatus && currentStatus === 'healthy') {
        console.log(`   ✅ Status recovered: ${previousStatus} → ${currentStatus} (no email sent)`);
      } else if (previousStatus === currentStatus && currentStatus !== 'healthy') {
        console.log(`   ℹ️ Still ${currentStatus} (no new email sent)`);
      }

      // Update status history
      serverStatusHistory.set(url, currentStatus);
      console.log('');
    }

    console.log('─'.repeat(80) + '\n');
  };

  // Run first check immediately
  await checkAllServers();

  // Schedule periodic checks
  setInterval(async () => {
    await checkAllServers();
  }, checkInterval);
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

  const serverUrlsString = process.env.SERVER_URLS || 'http://20.7.146.191:3000/';
  const serverUrls = serverUrlsString.split(',').map(url => url.trim());
  const checkInterval = parseInt(process.env.CHECK_INTERVAL_MINUTES || '5') * 60 * 1000;

  if (!emailConfig.user || !emailConfig.password || !emailConfig.to) {
    console.error('❌ Error: Email configuration is missing!');
    console.error('Please create a .env file with EMAIL_USER, EMAIL_PASSWORD, and EMAIL_TO');
    process.exit(1);
  }

  if (serverUrls.length === 0) {
    console.error('❌ Error: No servers configured!');
    console.error('Please add SERVER_URLS to your .env file');
    process.exit(1);
  }

  await monitorServers(serverUrls, emailConfig, checkInterval);
}

main();

