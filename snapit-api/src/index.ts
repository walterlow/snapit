/**
 * SnapIt Feedback API
 * Cloudflare Worker for handling user feedback submissions
 */

export interface Env {
  FEEDBACK_KV: KVNamespace;
  RESEND_API_KEY: string;
  NOTIFICATION_EMAIL: string;
}

interface FeedbackPayload {
  message: string;
  logs?: string;
  systemInfo: {
    platform: string;
    userAgent: string;
  };
  appVersion: string;
}

// Rate limiting config
const RATE_LIMIT_WINDOW = 60 * 60; // 1 hour in seconds
const MAX_REQUESTS_PER_WINDOW = 5; // Max 5 feedback submissions per hour per IP

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function handleCORS(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

async function checkRateLimit(ip: string, env: Env): Promise<{ allowed: boolean; remaining: number }> {
  const key = `ratelimit:${ip}`;
  const data = await env.FEEDBACK_KV.get(key);

  const now = Math.floor(Date.now() / 1000);
  let count = 0;
  let windowStart = now;

  if (data) {
    const parsed = JSON.parse(data);
    // Check if we're still in the same window
    if (now - parsed.windowStart < RATE_LIMIT_WINDOW) {
      count = parsed.count;
      windowStart = parsed.windowStart;
    }
  }

  if (count >= MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, remaining: 0 };
  }

  // Increment counter
  await env.FEEDBACK_KV.put(
    key,
    JSON.stringify({ count: count + 1, windowStart }),
    { expirationTtl: RATE_LIMIT_WINDOW }
  );

  return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - count - 1 };
}

async function handleFeedback(request: Request, env: Env): Promise<Response> {
  try {
    // Rate limiting
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimit = await checkRateLimit(ip, env);

    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({ error: 'Too many requests. Please try again later.' }),
        { status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const payload: FeedbackPayload = await request.json();
    const { message, logs, systemInfo, appVersion } = payload;

    // Basic validation
    if (message.length > 10000) {
      return new Response(
        JSON.stringify({ error: 'Message too long (max 10000 characters)' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    if (!message?.trim()) {
      return new Response(
        JSON.stringify({ error: 'Message is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // Store feedback in KV
    await env.FEEDBACK_KV.put(
      id,
      JSON.stringify({
        id,
        message,
        logs: logs ? '[LOGS ATTACHED]' : null, // Don't store full logs in KV, just a marker
        systemInfo,
        appVersion,
        timestamp,
      }),
      { expirationTtl: 60 * 60 * 24 * 90 } // Keep for 90 days
    );

    // Send email notification via Resend
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'SnapIt Feedback <onboarding@resend.dev>',
        to: env.NOTIFICATION_EMAIL,
        subject: `[SnapIt] ${message.slice(0, 60)}${message.length > 60 ? '...' : ''}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #f97316; border-bottom: 2px solid #f97316; padding-bottom: 10px;">New Feedback Received</h2>

            <div style="background: #f8fafc; padding: 16px; border-radius: 8px; margin: 16px 0;">
              <p style="margin: 0; white-space: pre-wrap;">${escapeHtml(message)}</p>
            </div>

            <h3 style="color: #64748b; font-size: 14px; margin-top: 24px;">System Information</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <tr>
                <td style="padding: 8px 0; color: #64748b;">Platform</td>
                <td style="padding: 8px 0;">${escapeHtml(systemInfo.platform)}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #64748b;">App Version</td>
                <td style="padding: 8px 0;">${escapeHtml(appVersion)}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #64748b;">User Agent</td>
                <td style="padding: 8px 0; font-size: 12px;">${escapeHtml(systemInfo.userAgent)}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #64748b;">Feedback ID</td>
                <td style="padding: 8px 0; font-family: monospace; font-size: 12px;">${id}</td>
              </tr>
            </table>

            ${logs ? `
              <h3 style="color: #64748b; font-size: 14px; margin-top: 24px;">Application Logs</h3>
              <details style="background: #1e293b; color: #e2e8f0; padding: 16px; border-radius: 8px; margin: 8px 0;">
                <summary style="cursor: pointer; margin-bottom: 8px;">Click to expand logs</summary>
                <pre style="margin: 0; white-space: pre-wrap; font-size: 11px; overflow-x: auto;">${escapeHtml(logs)}</pre>
              </details>
            ` : '<p style="color: #64748b; font-size: 14px;">No logs attached</p>'}

            <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">
              Received at ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC
            </p>
          </div>
        `,
      }),
    });

    if (!emailResponse.ok) {
      console.error('Failed to send email:', await emailResponse.text());
      // Don't fail the request if email fails - feedback is already stored
    }

    return new Response(
      JSON.stringify({ success: true, id }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  } catch (error) {
    console.error('Error handling feedback:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    // Route requests
    if (request.method === 'POST' && url.pathname === '/feedback') {
      return handleFeedback(request, env);
    }

    // Health check
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};
