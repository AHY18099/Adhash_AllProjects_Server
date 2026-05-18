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
  isActive: boolean;
  statusCode?: number;
  statusText?: string;
  responseTime?: number;
  error?: string;
  timestamp: Date;
}

let lastStatus: 'healthy' | 'unhealthy' | 'down' | null = null;

async function sendEmail(config: EmailConfig, status: ServerStatus, serverUrl: string) {
  const transportConfig: any = {
    auth: {
      user: config.user,
      pass: config.password,
    },
  };

  // Use custom SMTP settings if host is provided, otherwise use service
  if (config.host) {
    transportConfig.host = config.host;
    transportConfig.port = config.port || 465;
    transportConfig.secure = config.secure !== undefined ? config.secure : true;
  } else if (config.service) {
    transportConfig.service = config.service;
  }

  const transporter = nodemailer.createTransport(transportConfig);

  const autoCheckerIps = ['20.7.146.191', '20.1.198.58'];
  const isAutoChecker = autoCheckerIps.some(ip => serverUrl.includes(ip));
  const subject = status.isActive
    ? `⚠️ Server Health Alert - ${serverUrl}`
    : isAutoChecker
      ? 'Auto Checker Server Down'
      : `🚨 Server DOWN Alert - ${serverUrl}`;

  const statusText = status.isActive ? 'ACTIVE' : 'INACTIVE';
  const statusColor = status.isActive ? '#ff9800' : '#f44336';
  const statusIcon = status.isActive ? '⚠️' : '🚨';

  const htmlContent = `
    <html>
      <body style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
        <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h2 style="color: ${statusColor}; margin-top: 0;">
            ${statusIcon} Server Status Alert
          </h2>

          <div style="background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #333;">Server Information</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #666; width: 150px;"><strong>Server Address:</strong></td>
                <td style="padding: 8px 0; color: #333;">${serverUrl}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Status:</strong></td>
                <td style="padding: 8px 0; color: ${statusColor}; font-weight: bold; font-size: 16px;">${statusText}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Timestamp:</strong></td>
                <td style="padding: 8px 0; color: #333;">${status.timestamp.toLocaleString()}</td>
              </tr>
              ${status.isActive ? `
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Status Code:</strong></td>
                <td style="padding: 8px 0; color: #333;">${status.statusCode} ${status.statusText}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Response Time:</strong></td>
                <td style="padding: 8px 0; color: #333;">${status.responseTime}ms</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Issue:</strong></td>
                <td style="padding: 8px 0; color: #ff9800;">Server returned error status code</td>
              </tr>
              ` : `
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Error:</strong></td>
                <td style="padding: 8px 0; color: #f44336;">${status.error}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;"><strong>Issue:</strong></td>
                <td style="padding: 8px 0; color: #f44336;">Server is not responding or unreachable</td>
              </tr>
              `}
            </table>
          </div>

          <hr style="margin: 20px 0; border: none; border-top: 1px solid #e0e0e0;">
          <p style="color: #999; font-size: 12px; margin-bottom: 0;">
            This is an automated alert from your Server Health Monitor.<br>
            Monitoring: ${serverUrl}
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
  } catch (error: any) {
    console.log(`   ❌ Failed to send email: ${error.message}`);
  }
}

async function checkServerHealth(url: string, emailConfig: EmailConfig): Promise<void> {
  console.log(`\n🔍 Checking server health at: ${url}`);
  console.log(`   Time: ${new Date().toLocaleString()}\n`);
  
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
    
    console.log('✅ Server is ACTIVE');
    console.log(`   Status Code: ${status} ${statusText}`);
    console.log(`   Response Time: ${responseTime}ms`);
    
    const serverStatus: ServerStatus = {
      isActive: true,
      statusCode: status,
      statusText: statusText,
      responseTime: responseTime,
      timestamp: new Date()
    };
    
    if (status >= 200 && status < 400) {
      console.log(`   Health: HEALTHY ✓`);
      if (lastStatus !== 'healthy') {
        console.log(`   Status changed to HEALTHY - no alert needed.`);
        lastStatus = 'healthy';
      }
    } else {
      console.log(`   Health: UNHEALTHY (Status ${status}) ⚠️`);
      if (lastStatus !== 'unhealthy') {
        console.log(`   Status changed to UNHEALTHY - sending email alert...`);
        await sendEmail(emailConfig, serverStatus, url);
        lastStatus = 'unhealthy';
      } else {
        console.log(`   Still UNHEALTHY - no new alert sent.`);
      }
    }
    
  } catch (error: any) {
    console.log('❌ Server is NOT ACTIVE or UNREACHABLE');
    console.log(`   Error: ${error.message}`);
    
    const serverStatus: ServerStatus = {
      isActive: false,
      error: error.message,
      timestamp: new Date()
    };
    
    if (lastStatus !== 'down') {
      console.log(`   Status changed to DOWN - sending email alert...`);
      await sendEmail(emailConfig, serverStatus, url);
      lastStatus = 'down';
    } else {
      console.log(`   Still DOWN - no new alert sent.`);
    }
  } finally {
    await context.dispose();
    console.log('✨ Health check completed\n');
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

  const serverUrl = process.env.SERVER_URL || 'http://20.7.146.191:3000/';
  const checkInterval = parseInt(process.env.CHECK_INTERVAL_MINUTES || '5') * 60 * 1000;

  if (!emailConfig.user || !emailConfig.password || !emailConfig.to) {
    console.error('❌ Error: Email configuration is missing!');
    console.error('Please create a .env file with EMAIL_USER, EMAIL_PASSWORD, and EMAIL_TO');
    process.exit(1);
  }

  console.log('🚀 Server Monitor Started');
  console.log(`   Server: ${serverUrl}`);
  console.log(`   Check Interval: ${checkInterval / 60000} minutes`);
  console.log(`   Email From: ${emailConfig.user}`);
  console.log(`   Email To: ${emailConfig.to}`);
  console.log(`   SMTP: ${emailConfig.host || emailConfig.service}`);
  console.log('   Press Ctrl+C to stop\n');

  // Run first check immediately
  await checkServerHealth(serverUrl, emailConfig);

  // Schedule periodic checks
  setInterval(async () => {
    await checkServerHealth(serverUrl, emailConfig);
  }, checkInterval);
}

main();

