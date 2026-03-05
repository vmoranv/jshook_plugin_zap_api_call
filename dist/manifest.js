import { getPluginBooleanConfig, loadPluginEnv } from '@jshookmcp/extension-sdk/plugin';
loadPluginEnv(import.meta.url);
function toText(payload) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
function toErr(tool, error, extra = {}) {
    return toText({ success: false, tool, error: error instanceof Error ? error.message : String(error), ...extra });
}
function isLoopbackUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return false;
        const host = url.hostname.replace(/^\[|\]$/g, '');
        return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    }
    catch {
        return false;
    }
}
function normalizeBaseUrl(value) {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
}
function buildUrl(baseUrl, path, query = {}) {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${baseUrl.replace(/\/$/, '')}${normalizedPath}`);
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '')
            continue;
        url.searchParams.set(k, String(v));
    }
    return url.toString();
}
async function requestJson(url, method = 'GET', bodyObj = undefined) {
    const body = bodyObj ? new URLSearchParams(bodyObj).toString() : undefined;
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
    let data = {};
    if (text.length > 0) {
        try {
            data = JSON.parse(text);
        }
        catch {
            data = { text };
        }
    }
    return { status: res.status, data };
}
class ZapHandlers {
    baseUrl;
    apiKey;
    constructor(baseUrl = 'http://127.0.0.1:8080', apiKey) {
        if (!isLoopbackUrl(baseUrl)) {
            throw new Error(`ZAP bridge only allows loopback addresses, got "${baseUrl}"`);
        }
        this.baseUrl = normalizeBaseUrl(baseUrl);
        this.apiKey = apiKey?.trim() || undefined;
    }
    async handleZapApiCall(args) {
        const format = String(args.format ?? 'JSON').toUpperCase();
        const component = String(args.component ?? '');
        const callType = String(args.callType ?? 'view');
        const operation = String(args.operation ?? '');
        const method = String(args.method ?? 'GET').toUpperCase();
        const rawParams = args.params;
        const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
            ? rawParams
            : {};
        if (!component || !callType || !operation) {
            return toErr('zap_api_call', new Error('component, callType, and operation are required'));
        }
        try {
            const path = `/${format}/${component}/${callType}/${operation}/`;
            const query = { ...params, apikey: this.apiKey };
            const url = buildUrl(this.baseUrl, path, method === 'GET' ? query : {});
            const { status, data } = await requestJson(url, method, method === 'GET' ? undefined : query);
            return toText({
                success: status >= 200 && status < 300,
                endpoint: this.baseUrl,
                path,
                method,
                status,
                data,
            });
        }
        catch (error) {
            return toErr('zap_api_call', error, { endpoint: this.baseUrl });
        }
    }
    async handleZapCoreVersion(_args) {
        try {
            const url = buildUrl(this.baseUrl, '/JSON/core/view/version/', { apikey: this.apiKey });
            const { status, data } = await requestJson(url, 'GET');
            return toText({ success: status >= 200 && status < 300, endpoint: this.baseUrl, status, data });
        }
        catch (error) {
            return toErr('zap_core_version', error, { endpoint: this.baseUrl });
        }
    }
}
const tools = [
    {
        name: 'zap_api_call',
        description: 'Generic OWASP ZAP REST API caller for one endpoint action.',
        inputSchema: {
            type: 'object',
            properties: {
                format: {
                    type: 'string',
                    enum: ['JSON', 'OTHER', 'HTML'],
                    default: 'JSON',
                },
                component: { type: 'string' },
                callType: {
                    type: 'string',
                    enum: ['view', 'action', 'other'],
                },
                operation: { type: 'string' },
                method: {
                    type: 'string',
                    enum: ['GET', 'POST'],
                    default: 'GET',
                },
                params: {
                    type: 'object',
                    additionalProperties: true,
                },
            },
            required: ['component', 'callType', 'operation'],
        },
    },
    {
        name: 'zap_core_version',
        description: 'Get OWASP ZAP version from /JSON/core/view/version/.',
        inputSchema: { type: 'object', properties: {} },
    },
];
const DEP_KEY = 'zapHandlers';
const DOMAIN = 'zap-api-call';
function bind(methodName) {
    return (deps) => async (args) => {
        const handlers = deps[DEP_KEY];
        const method = handlers[methodName];
        if (typeof method !== 'function') {
            throw new Error(`Missing ZAP handler: ${methodName}`);
        }
        return method(args ?? {});
    };
}
const domainManifest = {
    kind: 'domain-manifest',
    version: 1,
    domain: DOMAIN,
    depKey: DEP_KEY,
    profiles: ['workflow', 'full', 'reverse'],
    ensure() {
        const baseUrl = process.env.ZAP_API_URL ?? 'http://127.0.0.1:8080';
        const apiKey = process.env.ZAP_API_KEY;
        return new ZapHandlers(baseUrl, apiKey);
    },
    registrations: [
        { tool: tools[0], domain: DOMAIN, bind: bind('handleZapApiCall') },
        { tool: tools[1], domain: DOMAIN, bind: bind('handleZapCoreVersion') },
    ],
};
const plugin = {
    manifest: {
        kind: 'plugin-manifest',
        version: 1,
        id: 'io.github.vmoranv.zap-api-call',
        name: 'ZAP API',
        pluginVersion: '0.1.0',
        entry: 'manifest.js',
        description: 'Plugin exposing zap_api_call and zap_core_version.',
        compatibleCore: '>=0.1.0',
        permissions: {
            network: { allowHosts: ['127.0.0.1', 'localhost', '::1'] },
            process: { allowCommands: [] },
            filesystem: { readRoots: [], writeRoots: [] },
            toolExecution: { allowTools: ['zap_api_call', 'zap_core_version'] },
        },
        activation: { onStartup: false, profiles: ['workflow', 'full', 'reverse'] },
        contributes: {
            domains: [domainManifest],
            workflows: [],
            configDefaults: { 'plugins.zap-api-call.enabled': true },
            metrics: ['zap_api_call_calls_total', 'zap_core_version_calls_total'],
        },
    },
    onLoad(ctx) {
        ctx.setRuntimeData('loadedAt', new Date().toISOString());
    },
    onValidate(ctx) {
        const enabled = getPluginBooleanConfig(ctx, 'zap-api-call', 'enabled', true);
        if (!enabled)
            return { valid: false, errors: ['Plugin disabled by config'] };
        return { valid: true, errors: [] };
    },
    onRegister(ctx) {
        ctx.registerDomain(domainManifest);
        ctx.registerMetric('zap_api_call_calls_total');
        ctx.registerMetric('zap_core_version_calls_total');
    },
};
export default plugin;
