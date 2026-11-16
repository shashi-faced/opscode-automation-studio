/**
 * FlightRecorder - Passive CDP & Playwright session telemetry engine.
 * Records network traffic, console outputs, and page runtime exceptions
 * indexed chronologically and correlated with active automation test steps.
 * Automatically masks sensitive tokens, passwords, and authorization headers.
 */

const SENSITIVE_KEY_REGEX = /password|passwd|secret|token|auth|cookie|api[-_]?key|credit[-_]?card|cvv/i;

/**
 * Recursively masks sensitive fields in an object or query string.
 */
export function maskSensitiveData(input) {
  if (!input) return input;

  if (typeof input === 'string') {
    // If it looks like JSON, parse, mask, and re-serialize
    const trimmed = input.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        return JSON.stringify(maskSensitiveData(parsed));
      } catch {}
    }

    // Mask URL query parameters (e.g. ?access_token=xyz, &password=abc, &api_key=123)
    let sanitized = input.replace(/([?&][^=&#]*(?:password|passwd|secret|token|auth|key|credential|cookie)[^=&#]*=)([^&#]+)/gi, '$1••••••••');
    // Mask Bearer & Basic tokens in strings
    sanitized = sanitized.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1••••••••');
    sanitized = sanitized.replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, '$1••••••••');
    return sanitized;
  }

  if (Array.isArray(input)) {
    return input.map(maskSensitiveData);
  }

  if (typeof input === 'object' && input !== null) {
    const masked = {};
    for (const [key, value] of Object.entries(input)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        masked[key] = '••••••••';
      } else if (typeof value === 'object' && value !== null) {
        masked[key] = maskSensitiveData(value);
      } else if (typeof value === 'string') {
        masked[key] = maskSensitiveData(value);
      } else {
        masked[key] = value;
      }
    }
    return masked;
  }

  return input;
}

export class FlightRecorder {
  constructor(page, options = {}) {
    this.page = page;
    this.options = {
      maskCredentials: true,
      maxPayloadLength: 2048,
      ...options,
    };
    this.currentStepIndex = 0;
    this.currentStepMeta = {};
    this.networkLogs = [];
    this.consoleLogs = [];
    this.pageErrors = [];
    this.pendingRequests = new Map();
    this.isActive = false;

    // Bound listeners for clean removal
    this._onRequest = this._handleRequest.bind(this);
    this._onResponse = this._handleResponse.bind(this);
    this._onRequestFailed = this._handleRequestFailed.bind(this);
    this._onConsole = this._handleConsole.bind(this);
    this._onPageError = this._handlePageError.bind(this);
  }

  /**
   * Start listening to page events
   */
  start() {
    if (this.isActive || !this.page) return;
    this.isActive = true;

    try {
      this.page.on('request', this._onRequest);
      this.page.on('response', this._onResponse);
      this.page.on('requestfailed', this._onRequestFailed);
      this.page.on('console', this._onConsole);
      this.page.on('pageerror', this._onPageError);
    } catch (err) {
      // In mock environments where page.on might differ
      console.warn(`[FlightRecorder] Failed to attach listeners: ${err.message}`);
    }
  }

  /**
   * Stop listening and detach from page
   */
  stop() {
    if (!this.isActive || !this.page) return;
    this.isActive = false;

    try {
      if (typeof this.page.off === 'function') {
        this.page.off('request', this._onRequest);
        this.page.off('response', this._onResponse);
        this.page.off('requestfailed', this._onRequestFailed);
        this.page.off('console', this._onConsole);
        this.page.off('pageerror', this._onPageError);
      } else if (typeof this.page.removeListener === 'function') {
        this.page.removeListener('request', this._onRequest);
        this.page.removeListener('response', this._onResponse);
        this.page.removeListener('requestfailed', this._onRequestFailed);
        this.page.removeListener('console', this._onConsole);
        this.page.removeListener('pageerror', this._onPageError);
      }
    } catch {}
  }

  /**
   * Update active step index to correlate events with specific execution steps
   */
  setStep(index, stepMeta = {}) {
    this.currentStepIndex = index;
    this.currentStepMeta = stepMeta;
  }

  /**
   * Retrieve in-flight pending requests for a specific step or across all steps
   */
  getPendingRequests(stepIndex) {
    const pending = [];
    for (const [req, meta] of this.pendingRequests.entries()) {
      if (stepIndex === undefined || meta.stepIndex === stepIndex) {
        pending.push({
          url: this._sanitizeUrl(meta.url || (typeof req.url === 'function' ? req.url() : '')),
          method: meta.method || (typeof req.method === 'function' ? req.method() : 'GET'),
          startTime: meta.startTime,
          durationMs: Math.max(0, Date.now() - meta.startTime),
          stepIndex: meta.stepIndex,
        });
      }
    }
    return pending;
  }

  /**
   * Check if any network requests are currently pending in-flight
   */
  hasPendingRequests(stepIndex) {
    for (const [, meta] of this.pendingRequests.entries()) {
      if (stepIndex === undefined || meta.stepIndex === stepIndex) {
        return true;
      }
    }
    return false;
  }

  /**
   * Retrieve telemetry entries correlated with a specific step
   */
  getStepTelemetry(index) {
    const network = this.networkLogs.filter((l) => l.stepIndex === index);
    const consoleEntries = this.consoleLogs.filter((l) => l.stepIndex === index);
    const errors = this.pageErrors.filter((l) => l.stepIndex === index);
    const pending = this.getPendingRequests(index);

    const hasNetworkError = network.some((l) => l.failed);
    const hasConsoleError = consoleEntries.some((l) => l.type === 'error') || errors.length > 0;

    return {
      stepIndex: index,
      networkCalls: network,
      pendingRequests: pending,
      consoleErrors: [
        ...consoleEntries.filter((l) => l.type === 'error' || l.type === 'warning'),
        ...errors,
      ],
      allConsoleLogs: consoleEntries,
      hasNetworkError,
      hasConsoleError,
    };
  }

  /**
   * Get complete telemetry aggregated across entire flow run
   */
  getAllTelemetry() {
    return {
      totalNetworkCalls: this.networkLogs.length,
      failedNetworkCalls: this.networkLogs.filter((l) => l.failed).length,
      totalConsoleErrors: this.consoleLogs.filter((l) => l.type === 'error').length + this.pageErrors.length,
      networkLogs: this.networkLogs,
      consoleLogs: this.consoleLogs,
      pageErrors: this.pageErrors,
    };
  }

  /**
   * Reset in-memory buffers
   */
  clear() {
    this.networkLogs = [];
    this.consoleLogs = [];
    this.pageErrors = [];
    this.pendingRequests.clear();
  }

  _sanitizeUrl(url) {
    if (!url) return '';
    return this.options.maskCredentials ? maskSensitiveData(url) : url;
  }

  _handleRequest(req) {
    if (!req) return;
    const reqMeta = {
      startTime: Date.now(),
      stepIndex: this.currentStepIndex,
      url: typeof req.url === 'function' ? req.url() : '',
      method: typeof req.method === 'function' ? req.method() : 'GET',
    };
    this.pendingRequests.set(req, reqMeta);
  }

  async _handleResponse(res) {
    if (!res) return;
    const req = typeof res.request === 'function' ? res.request() : null;
    const reqMeta = (req && this.pendingRequests.get(req)) || {
      startTime: Date.now(),
      stepIndex: this.currentStepIndex,
    };
    if (req) {
      this.pendingRequests.delete(req);
    }

    const durationMs = Math.max(0, Date.now() - reqMeta.startTime);
    const status = typeof res.status === 'function' ? res.status() : 200;
    const failed = status >= 400;
    const url = typeof res.url === 'function' ? res.url() : (req?.url?.() || '');
    const method = req?.method?.() || 'GET';
    const resourceType = req?.resourceType?.() || 'xhr';

    let requestPreview = '';
    try {
      const postData = req?.postData?.();
      if (postData) {
        requestPreview = this.options.maskCredentials ? maskSensitiveData(postData) : postData;
        if (requestPreview.length > this.options.maxPayloadLength) {
          requestPreview = requestPreview.slice(0, this.options.maxPayloadLength) + '... [truncated]';
        }
      }
    } catch {}

    let responsePreview = '';
    if (failed || resourceType === 'fetch' || resourceType === 'xhr') {
      try {
        const text = await res.text().catch(() => '');
        if (text) {
          responsePreview = this.options.maskCredentials ? maskSensitiveData(text) : text;
          if (responsePreview.length > this.options.maxPayloadLength) {
            responsePreview = responsePreview.slice(0, this.options.maxPayloadLength) + '... [truncated]';
          }
        }
      } catch {}
    }

    this.networkLogs.push({
      stepIndex: reqMeta.stepIndex,
      timestamp: Date.now(),
      url: this._sanitizeUrl(url),
      method,
      status,
      durationMs,
      failed,
      resourceType,
      errorText: failed ? `HTTP ${status}` : undefined,
      requestPreview: requestPreview || undefined,
      responsePreview: responsePreview || undefined,
    });
  }

  _handleRequestFailed(req) {
    if (!req) return;
    const reqMeta = this.pendingRequests.get(req) || {
      startTime: Date.now(),
      stepIndex: this.currentStepIndex,
    };
    this.pendingRequests.delete(req);

    const durationMs = Math.max(0, Date.now() - reqMeta.startTime);
    const url = typeof req.url === 'function' ? req.url() : '';
    const method = typeof req.method === 'function' ? req.method() : 'GET';
    const failure = typeof req.failure === 'function' ? req.failure() : null;
    const errorText = failure?.errorText || 'Request failed';

    let requestPreview = '';
    try {
      const postData = req.postData?.();
      if (postData) {
        requestPreview = this.options.maskCredentials ? maskSensitiveData(postData) : postData;
        if (requestPreview.length > this.options.maxPayloadLength) {
          requestPreview = requestPreview.slice(0, this.options.maxPayloadLength) + '... [truncated]';
        }
      }
    } catch {}

    this.networkLogs.push({
      stepIndex: reqMeta.stepIndex,
      timestamp: Date.now(),
      url: this._sanitizeUrl(url),
      method,
      status: 0,
      durationMs,
      failed: true,
      resourceType: req.resourceType?.() || 'xhr',
      errorText,
      requestPreview: requestPreview || undefined,
    });
  }

  _handleConsole(msg) {
    if (!msg) return;
    const type = typeof msg.type === 'function' ? msg.type() : 'log';
    const text = typeof msg.text === 'function' ? msg.text() : String(msg);
    const location = typeof msg.location === 'function' ? msg.location() : null;

    let locStr = undefined;
    if (location && location.url) {
      locStr = `${location.url}:${location.lineNumber || 0}`;
    }

    this.consoleLogs.push({
      stepIndex: this.currentStepIndex,
      timestamp: Date.now(),
      type: type === 'warning' ? 'warning' : type === 'error' ? 'error' : 'info',
      text: this.options.maskCredentials ? maskSensitiveData(text) : text,
      location: locStr,
    });
  }

  _handlePageError(err) {
    if (!err) return;
    const text = err.message || String(err);
    this.pageErrors.push({
      stepIndex: this.currentStepIndex,
      timestamp: Date.now(),
      type: 'exception',
      text: this.options.maskCredentials ? maskSensitiveData(text) : text,
      stack: err.stack ? (this.options.maskCredentials ? maskSensitiveData(err.stack) : err.stack) : undefined,
    });
  }
}
