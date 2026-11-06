import { logger } from "@/lib/logger";
import type { BillingProvider } from "../types";
import { MockBillingProvider } from "./mock";
import { StripeBillingProvider } from "./stripe";

let provider: BillingProvider | undefined;

/** Stripe when STRIPE_SECRET_KEY is set; the mock otherwise. */
export function getBillingProvider(): BillingProvider {
  if (!provider) {
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    provider = key ? new StripeBillingProvider(key) : new MockBillingProvider();
    logger.info({ provider: provider.name }, "billing provider selected");
  }
  return provider;
}

export function getStripeProvider(): StripeBillingProvider | null {
  const p = getBillingProvider();
  return p instanceof StripeBillingProvider ? p : null;
}

/** Test-only. */
export function setBillingProviderForTests(p: BillingProvider | undefined) {
  provider = p;
}

export const isMockPriceId = (id: string | null | undefined) => !!id?.startsWith("mock_price_");
