import { vi } from "vitest";

/** Deterministic WebIDL-style prototype boundary; this is not engine proof. */
export function installPassivePlatform(timeOrigin: number) {
  const fields = new WeakMap<object, Record<string, unknown>>();
  class NativeTiming { constructor(value: Record<string, unknown>) { fields.set(this, value); } }
  class NativeCspEvent extends Event { constructor(value: Record<string, unknown>) { super("securitypolicyviolation"); fields.set(this, value); } }
  for (const [prototype, keys] of [[NativeTiming.prototype, ["name", "startTime", "duration", "transferSize", "responseStatus", "redirectEnd"]],
    [NativeCspEvent.prototype, ["blockedURI", "statusCode", "effectiveDirective", "disposition"]]] as const) {
    for (const key of keys) Object.defineProperty(prototype, key, { configurable: true, get(this: object): unknown {
      if (!fields.has(this)) throw new TypeError("Illegal invocation");
      return fields.get(this)?.[key];
    } });
  }
  class NativeList { constructor(public readonly entries: unknown[]) {} getEntries(): unknown[] { return this.entries; } }
  let callback: PerformanceObserverCallback | undefined;
  let cspListener: EventListener | undefined;
  const observe = vi.fn(), disconnect = vi.fn(), add = vi.fn((type: string, listener: EventListener) => { if (type === "securitypolicyviolation") cspListener = listener; });
  class Observer { constructor(listener: PerformanceObserverCallback) { callback = listener; } observe = observe; disconnect = disconnect; }
  const remove = vi.fn();
  vi.stubGlobal("PerformanceObserver", Observer); vi.stubGlobal("PerformanceObserverEntryList", NativeList);
  vi.stubGlobal("PerformanceResourceTiming", NativeTiming); vi.stubGlobal("SecurityPolicyViolationEvent", NativeCspEvent);
  vi.stubGlobal("performance", { timeOrigin }); vi.stubGlobal("addEventListener", add); vi.stubGlobal("removeEventListener", remove);
  return { observe, disconnect, add, remove,
    timing: (value: Record<string, unknown>) => new NativeTiming(value), csp: (value: Record<string, unknown>) => new NativeCspEvent(value),
    entries(entries: unknown[]) { if (!callback) throw new Error("observer not attached"); callback(new NativeList(entries) as unknown as PerformanceObserverEntryList, {} as PerformanceObserver); },
    violation(event: Event) { if (!cspListener) throw new Error("CSP listener not attached"); cspListener(event); }
  };
}
