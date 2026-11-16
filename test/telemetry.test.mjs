import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FlightRecorder, maskSensitiveData } from '../src/telemetry/flightRecorder.mjs';

describe('Flight Recorder Telemetry Engine', () => {
  test('maskSensitiveData masks password and token fields', () => {
    const payload = {
      user: 'john_doe',
      password: 'superSecretPassword123!',
      nested: {
        token: 'ey1234567890abcdef',
        normalKey: 'visible value',
      },
      headers: {
        authorization: 'Bearer token-12345-secret',
      },
    };

    const masked = maskSensitiveData(payload);
    assert.equal(masked.user, 'john_doe');
    assert.equal(masked.password, '••••••••');
    assert.equal(masked.nested.token, '••••••••');
    assert.equal(masked.nested.normalKey, 'visible value');
    assert.equal(masked.headers.authorization, '••••••••');
  });

  test('maskSensitiveData masks URL query params and bearer strings', () => {
    const url = 'https://api.example.com/v1/auth?token=abcdef123456&username=admin&access_token=secret_tok&api_key=secret_key&client_secret=topsecret';
    const masked = maskSensitiveData(url);
    assert.match(masked, /token=••••••••/);
    assert.match(masked, /access_token=••••••••/);
    assert.match(masked, /api_key=••••••••/);
    assert.match(masked, /client_secret=••••••••/);
    assert.match(masked, /username=admin/);

    const bearerStr = 'Authorization: Bearer secret_access_token_jwt';
    const maskedBearer = maskSensitiveData(bearerStr);
    assert.match(maskedBearer, /Bearer ••••••••/);

    const basicStr = 'Authorization: Basic dXNlcjpwYXNzd29yZA==';
    const maskedBasic = maskSensitiveData(basicStr);
    assert.match(maskedBasic, /Basic ••••••••/);
  });

  test('tracks in-flight pending requests across start, response, and failure', async () => {
    const mockPage = new EventEmitter();
    const recorder = new FlightRecorder(mockPage);
    recorder.start();

    recorder.setStep(1, { action: 'click' });
    const mockReq = {
      url: () => 'https://api.example.com/v1/slow-call?access_token=secret123',
      method: () => 'POST',
      resourceType: () => 'fetch',
      postData: () => null,
    };

    assert.equal(recorder.hasPendingRequests(), false);
    mockPage.emit('request', mockReq);
    assert.equal(recorder.hasPendingRequests(), true);
    assert.equal(recorder.getPendingRequests(1).length, 1);
    assert.match(recorder.getPendingRequests(1)[0].url, /access_token=••••••••/);

    // After response arrives, pending count drops to 0
    await recorder._handleResponse({
      request: () => mockReq,
      status: () => 200,
      url: () => 'https://api.example.com/v1/slow-call',
      text: async () => '{"ok": true}',
    });
    assert.equal(recorder.hasPendingRequests(), false);
    recorder.stop();
  });

  test('records requests, responses and correlates with active stepIndex', async () => {
    const mockPage = new EventEmitter();
    const recorder = new FlightRecorder(mockPage);
    recorder.start();

    // Step 1
    recorder.setStep(1, { action: 'goto' });

    const mockReq1 = {
      url: () => 'https://example.com/api/data',
      method: () => 'GET',
      resourceType: () => 'fetch',
      postData: () => null,
    };
    mockPage.emit('request', mockReq1);

    const mockRes1 = {
      request: () => mockReq1,
      status: () => 200,
      url: () => 'https://example.com/api/data',
      text: async () => '{"success": true}',
    };
    await recorder._handleResponse(mockRes1);

    // Step 2
    recorder.setStep(2, { action: 'click' });

    const mockReq2 = {
      url: () => 'https://example.com/api/login?token=sensitive123',
      method: () => 'POST',
      resourceType: () => 'xhr',
      postData: () => JSON.stringify({ password: 'myPassword!' }),
    };
    mockPage.emit('request', mockReq2);

    const mockRes2 = {
      request: () => mockReq2,
      status: () => 500,
      url: () => 'https://example.com/api/login',
      text: async () => '{"error": "Internal Server Error"}',
    };
    await recorder._handleResponse(mockRes2);

    const step1Telemetry = recorder.getStepTelemetry(1);
    assert.equal(step1Telemetry.stepIndex, 1);
    assert.equal(step1Telemetry.networkCalls.length, 1);
    assert.equal(step1Telemetry.networkCalls[0].status, 200);
    assert.equal(step1Telemetry.hasNetworkError, false);

    const step2Telemetry = recorder.getStepTelemetry(2);
    assert.equal(step2Telemetry.stepIndex, 2);
    assert.equal(step2Telemetry.networkCalls.length, 1);
    assert.equal(step2Telemetry.networkCalls[0].status, 500);
    assert.equal(step2Telemetry.networkCalls[0].failed, true);
    assert.equal(step2Telemetry.hasNetworkError, true);
    // Verify password in postData was masked
    assert.ok(step2Telemetry.networkCalls[0].requestPreview.includes('••••••••'));

    recorder.stop();
  });

  test('records console logs and page errors correctly', () => {
    const mockPage = new EventEmitter();
    const recorder = new FlightRecorder(mockPage);
    recorder.start();

    recorder.setStep(3, { action: 'assert' });

    mockPage.emit('console', {
      type: () => 'error',
      text: () => 'Uncaught TypeError: Cannot read properties of undefined',
      location: () => ({ url: 'https://example.com/app.js', lineNumber: 42 }),
    });

    mockPage.emit('pageerror', new Error('Script execution failed on line 12'));

    const stepTelemetry = recorder.getStepTelemetry(3);
    assert.equal(stepTelemetry.hasConsoleError, true);
    assert.equal(stepTelemetry.consoleErrors.length, 2);
    assert.equal(stepTelemetry.consoleErrors[0].location, 'https://example.com/app.js:42');
    assert.equal(stepTelemetry.consoleErrors[1].type, 'exception');

    recorder.stop();
  });
});
