"use strict";

/**
 * Lightweight Chrome DevTools Protocol (CDP) client using native WebSocket / HTTP.
 * Compatible with Node.js 20+ / Electron 43+.
 */
class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.closed = false;
  }

  async connect(timeoutMs = 15000) {
    if (this.ws && !this.closed) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`CDP connect timeout (${timeoutMs}ms): ${this.wsUrl}`));
        }
      }, timeoutMs);

      try {
        const ws = new WebSocket(this.wsUrl);
        this.ws = ws;

        ws.addEventListener("open", () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.closed = false;
            resolve();
          }
        });

        ws.addEventListener("message", (evt) => {
          try {
            const raw = typeof evt.data === "string" ? evt.data : evt.data.toString();
            const data = JSON.parse(raw);
            if (typeof data.id === "number") {
              const entry = this.pending.get(data.id);
              if (entry) {
                this.pending.delete(data.id);
                clearTimeout(entry.timer);
                if (data.error) {
                  entry.reject(new Error(`CDP Error [${data.error.code}]: ${data.error.message}`));
                } else {
                  entry.resolve(data.result || {});
                }
              }
            } else if (data.method) {
              const handlers = this.eventHandlers.get(data.method);
              if (handlers) {
                for (const fn of handlers) {
                  try {
                    fn(data.params || {});
                  } catch (_err) {
                    // ignore listener error
                  }
                }
              }
            }
          } catch (_err) {
            // ignore parse error
          }
        });

        ws.addEventListener("close", () => {
          this.closed = true;
          for (const [id, entry] of this.pending.entries()) {
            clearTimeout(entry.timer);
            entry.reject(new Error("CDP WebSocket closed"));
            this.pending.delete(id);
          }
        });

        ws.addEventListener("error", (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(`CDP WebSocket error: ${err?.message || "connection failed"}`));
          }
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  on(eventName, handler) {
    if (!this.eventHandlers.has(eventName)) {
      this.eventHandlers.set(eventName, []);
    }
    this.eventHandlers.get(eventName).push(handler);
  }

  async send(method, params = {}, timeoutMs = 30000) {
    if (!this.ws || this.closed) {
      throw new Error("CDP client is not connected");
    }
    this.msgId += 1;
    const id = this.msgId;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout (${timeoutMs}ms) on ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async evaluate(expression, awaitPromise = false, timeoutMs = 30000) {
    const res = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise,
      },
      timeoutMs
    );
    if (res && res.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        JSON.stringify(res.exceptionDetails);
      throw new Error(`JS Error: ${desc}`);
    }
    return res?.result?.value;
  }

  async navigate(url, waitMs = 3000) {
    await this.send("Page.navigate", { url });
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  async close() {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_err) {
        // ignore
      }
      this.ws = null;
    }
  }
}

async function getTargets(host = "127.0.0.1", port = 9222) {
  const res = await fetch(`http://${host}:${port}/json`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from CDP /json`);
  return res.json();
}

async function getBrowserWsUrl(host = "127.0.0.1", port = 9222) {
  const res = await fetch(`http://${host}:${port}/json/version`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from CDP /json/version`);
  const data = await res.json();
  return data.webSocketDebuggerUrl;
}

async function createIncognitoTarget(host = "127.0.0.1", port = 9222, url = "about:blank") {
  const browserWs = await getBrowserWsUrl(host, port);
  const browserCdp = new CDPClient(browserWs);
  await browserCdp.connect();
  try {
    const ctxRes = await browserCdp.send("Target.createBrowserContext", {
      disposeOnDetach: false,
    });
    const browserContextId = ctxRes.browserContextId;
    const targetRes = await browserCdp.send("Target.createTarget", {
      url,
      browserContextId,
    });
    const targetId = targetRes.targetId;

    await new Promise((r) => setTimeout(r, 350));
    const targets = await getTargets(host, port);
    for (const t of targets) {
      if (t.id === targetId && t.webSocketDebuggerUrl) {
        return {
          browserContextId,
          targetId,
          wsUrl: t.webSocketDebuggerUrl,
        };
      }
    }
    return {
      browserContextId,
      targetId,
      wsUrl: `ws://${host}:${port}/devtools/page/${targetId}`,
    };
  } finally {
    await browserCdp.close();
  }
}

async function disposeBrowserContext(host = "127.0.0.1", port = 9222, browserContextId) {
  if (!browserContextId) return;
  const browserWs = await getBrowserWsUrl(host, port);
  const browserCdp = new CDPClient(browserWs);
  await browserCdp.connect();
  try {
    await browserCdp.send("Target.disposeBrowserContext", { browserContextId });
  } catch (_err) {
    // ignore
  } finally {
    await browserCdp.close();
  }
}

async function closeTarget(host = "127.0.0.1", port = 9222, targetId) {
  if (!targetId) return;
  try {
    await fetch(`http://${host}:${port}/json/close/${targetId}`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch (_err) {
    // ignore
  }
}

module.exports = {
  CDPClient,
  getTargets,
  getBrowserWsUrl,
  createIncognitoTarget,
  disposeBrowserContext,
  closeTarget,
};
