import { expect, test } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { InternalResource, ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { registerInternalScheme } from "../src/internal-url.ts";

const OWNER_A = "tests/alpha";
const OWNER_B = "tests/beta";
const OWNER_BRAND = Symbol.for("omomp-shared/internal-url");

function schemeHandler(scheme: string, content: string): ProtocolHandler {
	return {
		scheme,
		spec: { backing: "virtual", selectors: "none", immutable: true },
		resolve(url): Promise<InternalResource> {
			return Promise.resolve({ url: url.href, content, contentType: "text/plain", size: content.length });
		},
	};
}

/** Registration order of every scheme, split into the built-in prefix and the rest. */
function schemeOrder(router: InternalUrlRouter): { builtin: string[]; other: string[] } {
	const builtin: string[] = [];
	const other: string[] = [];
	for (const scheme of router.specs().keys()) {
		if (router.isBuiltin(scheme)) builtin.push(scheme);
		else other.push(scheme);
	}
	return { builtin, other };
}

test("registered schemes serve their URL, and non-built-in schemes sort by name after the built-ins", async () => {
	const router = new InternalUrlRouter();
	const builtinOrder = [...router.specs().keys()];
	const zeta = schemeHandler("zeta", "zeta body");
	const alpha = schemeHandler("alpha", "alpha body");
	expect(registerInternalScheme(router, OWNER_A, zeta).kind).toBe("registered");
	expect(registerInternalScheme(router, OWNER_A, alpha).kind).toBe("registered");
	const order = schemeOrder(router);
	expect(order.builtin).toEqual(builtinOrder);
	expect(order.other).toEqual(["alpha", "zeta"]);
	// Reordering moved only positions; the handlers are the identical objects.
	expect(router.getHandler("alpha")).toBe(alpha);
	expect(router.getHandler("zeta")).toBe(zeta);
	const resource = await router.resolve("alpha://x");
	expect(resource?.content).toBe("alpha body");
});

test("a built-in scheme is refused with the reason and keeps its handler", () => {
	const router = new InternalUrlRouter();
	const original = router.getHandler("skill");
	const hijack = schemeHandler("skill", "hijack");
	const result = registerInternalScheme(router, OWNER_A, hijack);
	expect(result).toEqual({ kind: "builtin", reason: "omp owns skill://" });
	expect(router.getHandler("skill")).toBe(original);
	// A refused handler is not branded.
	expect(Reflect.get(hijack, OWNER_BRAND)).toBeUndefined();
});

test("a scheme held by a handler without an owner brand is refused", () => {
	const router = new InternalUrlRouter();
	const foreign = schemeHandler("foreign", "foreign body");
	router.register(foreign);
	const hijack = schemeHandler("foreign", "hijack");
	const result = registerInternalScheme(router, OWNER_A, hijack);
	expect(result).toEqual({ kind: "held", holder: { kind: "unbranded" }, reason: "a handler with no owner already holds foreign://" });
	expect(router.getHandler("foreign")).toBe(foreign);
	expect(Reflect.get(hijack, OWNER_BRAND)).toBeUndefined();
});

test("another owner is refused with the holding owner; the same owner replaces its handler", async () => {
	const router = new InternalUrlRouter();
	const first = schemeHandler("owned", "first body");
	expect(registerInternalScheme(router, OWNER_A, first).kind).toBe("registered");
	const hijack = schemeHandler("owned", "hijack");
	const result = registerInternalScheme(router, OWNER_B, hijack);
	expect(result).toEqual({ kind: "held", holder: { kind: "owner", id: OWNER_A }, reason: `${OWNER_A} already holds owned://` });
	expect(router.getHandler("owned")).toBe(first);
	expect(Reflect.get(hijack, OWNER_BRAND)).toBeUndefined();
	const replacement = schemeHandler("owned", "second body");
	expect(registerInternalScheme(router, OWNER_A, replacement).kind).toBe("registered");
	expect(router.getHandler("owned")).toBe(replacement);
	const resource = await router.resolve("owned://x");
	expect(resource?.content).toBe("second body");
});

test("ownership is recognized across two separately imported module instances", async () => {
	// Each consumer plugin carries its own copy of internal-url.ts. Dynamic imports exercise the
	// module boundary on purpose: Bun treats the ?v=2 specifier as a separate module instance, so
	// the two copies share only the process-global Symbol.for registry. The specifier goes through
	// a variable because tsc cannot resolve a query string in a literal module specifier.
	const secondInstance = "../src/internal-url.ts?v=2";
	const copyB: { registerInternalScheme: typeof registerInternalScheme } = await import(secondInstance);
	expect(copyB.registerInternalScheme).not.toBe(registerInternalScheme);
	const router = new InternalUrlRouter();
	expect(registerInternalScheme(router, OWNER_A, schemeHandler("shared", "first body")).kind).toBe("registered");
	// Copy B does not know this module's state, yet a different owner is still refused with the
	// owner this module recorded, and the same owner still replaces.
	expect(copyB.registerInternalScheme(router, OWNER_B, schemeHandler("shared", "hijack"))).toEqual({
		kind: "held",
		holder: { kind: "owner", id: OWNER_A },
		reason: `${OWNER_A} already holds shared://`,
	});
	const replacement = schemeHandler("shared", "second body");
	expect(copyB.registerInternalScheme(router, OWNER_A, replacement).kind).toBe("registered");
	expect(router.getHandler("shared")).toBe(replacement);
});

test("a frozen handler throws instead of registering unbranded", () => {
	const router = new InternalUrlRouter();
	const frozen = Object.freeze(schemeHandler("frozen", "body"));
	expect(() => registerInternalScheme(router, OWNER_A, frozen)).toThrow(TypeError);
	expect(router.getHandler("frozen")).toBeUndefined();
});
