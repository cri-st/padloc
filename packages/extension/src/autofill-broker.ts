import type { Field, VaultItem } from "@padloc/core/src/item";
import {
    AUTOFILL_BROKER_PROTOCOL_VERSION,
    AutofillBrokerPlanField,
    AutofillBrokerRequest,
    AutofillBrokerResponse,
} from "./autofill-broker-protocol";

export interface BrokerItemSource {
    item: VaultItem;
}

export interface BrokerTabBinding {
    tabId: number;
    origin: string;
}

export function originOf(url: string): string | null {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

export function isBrokerTabBindingCurrent(binding: BrokerTabBinding, tab: { id?: number; url?: string }): boolean {
    if (tab.id !== binding.tabId || !tab.url) return false;
    return originOf(tab.url) === binding.origin;
}

export interface PendingBrokerPlan {
    planId: string;
    request: AutofillBrokerRequest;
    fields: AutofillBrokerPlanField[];
    createdAt: number;
    tabBinding?: BrokerTabBinding;
}

export interface BrokerApproval {
    approvalId: string;
    planId: string;
    approvedAt: number;
    expiresAt: number;
}

export function buildUnlockedBrokerPlanResponse(
    request: AutofillBrokerRequest,
    items: BrokerItemSource[],
    tabBinding?: BrokerTabBinding,
    now = Date.now()
): { response: AutofillBrokerResponse; pendingPlan: PendingBrokerPlan } {
    const binding = requireBinding(request);
    const fields = collectMatchingFields(request, items);
    const planId = makeId("plan", binding.sessionId, binding.origin, fields.map((field) => field.fieldHash).join("|"));
    const pendingPlan = { planId, request, fields, createdAt: now, tabBinding };
    return {
        pendingPlan,
        response: {
            ok: true,
            protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            vaultState: "unlocked",
            reason: null,
            planId,
            fields,
            audit: audit("plan-fill", request, fields.length),
        },
    };
}

export function approveBrokerPlanResponse(
    request: AutofillBrokerRequest,
    pendingPlan: PendingBrokerPlan,
    now = Date.now()
): { response: AutofillBrokerResponse; approval: BrokerApproval } {
    if (request.planId !== pendingPlan.planId) throw new Error("Autofill approval plan mismatch");
    if (request.approved !== true) throw new Error("Autofill approval requires user approval");
    const ttlMs = Math.max(1, request.ttlSeconds || 120) * 1000;
    const approval = {
        approvalId: makeId("approval", pendingPlan.planId, String(now)),
        planId: pendingPlan.planId,
        approvedAt: now,
        expiresAt: now + ttlMs,
    };
    return {
        approval,
        response: {
            ok: true,
            protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            vaultState: "unlocked",
            reason: null,
            planId: pendingPlan.planId,
            approvalId: approval.approvalId,
            expiresAt: new Date(approval.expiresAt).toISOString(),
            audit: audit("approve", pendingPlan.request, pendingPlan.fields.length),
        },
    };
}

export async function mintBrokerBundleResponse(
    request: AutofillBrokerRequest,
    pendingPlan: PendingBrokerPlan,
    approval: BrokerApproval,
    items: BrokerItemSource[],
    now = Date.now()
): Promise<AutofillBrokerResponse> {
    if (request.planId !== pendingPlan.planId) throw new Error("Autofill bundle plan mismatch");
    if (request.approvalId !== approval.approvalId) throw new Error("Autofill bundle approval mismatch");
    if (approval.expiresAt <= now) throw new Error("Autofill approval expired");
    const values = await resolveBundleValues(pendingPlan, items);
    const bundleId = makeId("bundle", approval.approvalId, String(now));
    return {
        ok: true,
        protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        vaultState: "unlocked",
        reason: null,
        planId: pendingPlan.planId,
        approvalId: approval.approvalId,
        bundleId,
        expiresAt: new Date(approval.expiresAt).toISOString(),
        bundleFields: values,
        audit: audit("mint-fill-bundle", pendingPlan.request, values.length),
    };
}

export function applyBrokerBundleResponse(
    request: AutofillBrokerRequest,
    bundle: AutofillBrokerResponse,
    now = Date.now()
): AutofillBrokerResponse {
    if (request.planId !== bundle.planId) throw new Error("Autofill apply plan mismatch");
    if (request.bundleId !== bundle.bundleId) throw new Error("Autofill apply bundle mismatch");
    if (bundle.expiresAt && Date.parse(bundle.expiresAt) <= now) throw new Error("Autofill bundle expired");
    return {
        ok: true,
        protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        vaultState: "unlocked",
        reason: null,
        planId: bundle.planId,
        approvalId: bundle.approvalId,
        bundleId: bundle.bundleId,
        audit: audit("apply-fill-bundle", request, bundle.bundleFields ? bundle.bundleFields.length : 0),
    };
}

export function revokeBrokerBundleResponse(
    request: AutofillBrokerRequest,
    bundle: AutofillBrokerResponse
): AutofillBrokerResponse {
    if (request.planId !== bundle.planId) throw new Error("Autofill revoke plan mismatch");
    if (request.bundleId !== bundle.bundleId) throw new Error("Autofill revoke bundle mismatch");
    return {
        ok: true,
        protocolVersion: AUTOFILL_BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        vaultState: "unlocked",
        reason: null,
        planId: bundle.planId,
        approvalId: bundle.approvalId,
        bundleId: bundle.bundleId,
        audit: audit("revoke-fill-bundle", request, bundle.bundleFields ? bundle.bundleFields.length : 0),
    };
}

export function redactBrokerResponse(response: AutofillBrokerResponse): AutofillBrokerResponse {
    if (!response.bundleFields) return response;
    return {
        ...response,
        bundleFields: response.bundleFields.map(({ value: _value, ...field }) => ({ ...field, value: "" })),
    };
}

function collectMatchingFields(request: AutofillBrokerRequest, items: BrokerItemSource[]): AutofillBrokerPlanField[] {
    const requestFields = request.fields || [];
    const matches: AutofillBrokerPlanField[] = [];
    for (const requestField of requestFields) {
        const requestedRole = normalizeRole(requestField.role || "");
        if (!requestedRole || !requestField.selector) continue;
        const match = findFirstFieldForRole(items, requestedRole);
        if (!match) continue;
        matches.push({
            selector: requestField.selector,
            role: requestField.role || requestedRole,
            fieldHash: requestField.fieldHash || hashField(requestField.selector, requestedRole),
            itemId: match.item.id,
            itemName: match.item.name,
            fieldIndex: match.index,
            fieldName: match.field.name,
            valuePreview: previewValue(match.field, requestedRole),
            transactionOnly: Boolean(match.field.transactionOnly),
        });
    }
    return matches;
}

async function resolveBundleValues(pendingPlan: PendingBrokerPlan, items: BrokerItemSource[]) {
    const values = [];
    for (const planned of pendingPlan.fields) {
        const source = items.find(({ item }) => item.id === planned.itemId)?.item.fields[planned.fieldIndex];
        if (!source) throw new Error(`Autofill field source missing: ${planned.itemId}/${planned.fieldIndex}`);
        values.push({
            selector: planned.selector,
            role: planned.role,
            fieldHash: planned.fieldHash,
            value: await source.transform(),
            transactionOnly: planned.transactionOnly,
        });
    }
    return values;
}

function findFirstFieldForRole(
    items: BrokerItemSource[],
    role: string
): { item: VaultItem; field: Field; index: number } | null {
    for (const { item } of items) {
        const index = item.fields.findIndex((field) => normalizeRole(field.autofillRole || "") === role);
        if (index >= 0) {
            const field = item.fields[index];
            if (field) return { item, field, index };
        }
    }
    return null;
}

function requireBinding(request: AutofillBrokerRequest) {
    if (!request.binding) throw new Error("Autofill broker request missing binding");
    return request.binding;
}

function audit(
    operation: AutofillBrokerResponse["audit"]["operation"],
    request: AutofillBrokerRequest,
    fieldCount: number
) {
    return {
        operation,
        sessionId: request.binding ? request.binding.sessionId : null,
        origin: request.binding ? request.binding.origin : null,
        fieldCount,
        valuePolicy: "redacted audit only; no raw autofill values or passkey secrets",
    };
}

function normalizeRole(role: string): string {
    const normalized = role.replace(/^billing\./, "");
    if (normalized === "payment.cardholder_name") return "payment.card.cardholder_name";
    if (normalized === "payment.card.expiry_mm_yy") return "payment.card.expiry";
    return normalized;
}

function previewValue(field: Field, role: string): string {
    if (role === "payment.card.pan") return `card:${field.value.replace(/\D/g, "").slice(-4) || "unknown"}`;
    if (field.transactionOnly) return "transaction-only";
    return "stored";
}

function hashField(selector: string, role: string): string {
    let hash = 0;
    const input = `${selector}\0${role}`;
    for (let i = 0; i < input.length; i += 1) {
        hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
    }
    return `field_${hash.toString(16)}`;
}

function makeId(prefix: string, ...parts: string[]): string {
    return `${prefix}_${hashField(parts.join("|"), prefix).replace(/^field_/, "")}`;
}
