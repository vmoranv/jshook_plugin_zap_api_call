import {
  createExtension,
  jsonResponse,
  errorResponse,
} from '@jshookmcp/extension-sdk/plugin';
import type { ToolArgs, PluginLifecycleContext } from '@jshookmcp/extension-sdk/plugin';

const PLUGIN_SLUG = 'zap-api-call';

function getPluginBooleanConfig(
  ctx: PluginLifecycleContext,
  slug: string,
  key: string,
  fallback: boolean,
): boolean {
  const value = ctx.getConfig(`plugins.${slug}.${key}`, fallback);
  return typeof value === 'boolean' ? value : fallback;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}

function buildUrl(baseUrl: string, path: string, query: Record<string, unknown> = {}): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${baseUrl.replace(/\/$/, '')}${normalizedPath}`);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

type JsonObject = Record<string, unknown>;

async function requestJson(
  url: string,
  method = 'GET',
  bodyObj: JsonObject | undefined = undefined,
): Promise<{ status: number; data: JsonObject }> {
  const body = bodyObj ? new URLSearchParams(bodyObj as Record<string, string>).toString() : undefined;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data: JsonObject = {};
  if (text.length > 0) {
    try { data = JSON.parse(text) as JsonObject; } catch { data = { text }; }
  }
  return { status: res.status, data };
}

function getZapEndpoint(): { baseUrl: string; apiKey?: string } {
  const baseUrl = process.env.ZAP_API_URL ?? 'http://127.0.0.1:8080';
  if (!isLoopbackUrl(baseUrl)) {
    throw new Error(`ZAP bridge only allows loopback addresses, got "${baseUrl}"`);
  }
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey: process.env.ZAP_API_KEY?.trim() || undefined,
  };
}

async function handleZapApiCall(args: ToolArgs) {
  const { baseUrl, apiKey } = getZapEndpoint();
  const format = String(args.format ?? 'JSON').toUpperCase();
  const component = String(args.component ?? '');
  const callType = String(args.callType ?? 'view');
  const operation = String(args.operation ?? '');
  const method = String(args.method ?? 'GET').toUpperCase();
  const rawParams = args.params;
  const params =
    rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? (rawParams as JsonObject)
      : {};

  if (!component || !callType || !operation) {
    return errorResponse('zap_api_call', new Error('component, callType, and operation are required'));
  }

  try {
    const path = `/${format}/${component}/${callType}/${operation}/`;
    const query = { ...params, apikey: apiKey };
    const url = buildUrl(baseUrl, path, method === 'GET' ? query : {});
    const { status, data } = await requestJson(url, method, method === 'GET' ? undefined : query);

    return jsonResponse({
      success: status >= 200 && status < 300,
      endpoint: baseUrl,
      path,
      method,
      status,
      data,
    });
  } catch (error) {
    return errorResponse('zap_api_call', error, { endpoint: baseUrl });
  }
}

async function handleZapCoreVersion() {
  const { baseUrl, apiKey } = getZapEndpoint();
  try {
    const url = buildUrl(baseUrl, '/JSON/core/view/version/', { apikey: apiKey });
    const { status, data } = await requestJson(url, 'GET');
    return jsonResponse({ success: status >= 200 && status < 300, endpoint: baseUrl, status, data });
  } catch (error) {
    return errorResponse('zap_core_version', error, { endpoint: baseUrl });
  }
}

const plugin = createExtension('io.github.vmoranv.zap-api-call', '0.1.0')
  .compatibleCore('>=0.1.0')
  .profile(['workflow', 'full'])
  .allowHost(['127.0.0.1', 'localhost', '::1'])
  .allowTool(['zap_api_call', 'zap_core_version'])
  .configDefault('plugins.zap-api-call.enabled', true)
  .metric(['zap_api_call_calls_total', 'zap_core_version_calls_total'])
  .tool(
    'zap_api_call',
    'Generic OWASP ZAP REST API caller for one endpoint action.',
    {
      format: { type: 'string', enum: ['JSON', 'OTHER', 'HTML'], default: 'JSON' },
      component: { type: 'string' },
      callType: { type: 'string', enum: ['view', 'action', 'other'] },
      operation: { type: 'string' },
      method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
      params: { type: 'object', additionalProperties: true },
    },
    async (args) => handleZapApiCall(args),
  )
  .tool(
    'zap_core_version',
    'Get OWASP ZAP version from /JSON/core/view/version/.',
    {},
    async () => handleZapCoreVersion(),
  )
  .onLoad((ctx) => { ctx.setRuntimeData('loadedAt', new Date().toISOString()); })
  .onValidate((ctx: PluginLifecycleContext) => {
    const enabled = getPluginBooleanConfig(ctx, 'zap-api-call', 'enabled', true);
    if (!enabled) return { valid: false, errors: ['Plugin disabled by config'] };
    return { valid: true, errors: [] };
  });

Object.defineProperty(plugin, 'workflows', {
  value: [],
  enumerable: false,
  configurable: true,
  writable: false,
});

export default plugin;
