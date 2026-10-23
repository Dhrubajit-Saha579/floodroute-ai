import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey: string | undefined =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable."
  );
}

/**
 * Public client for UI components and realtime subscriptions.
 * Safe to use in the browser: relies on the anon key + Row Level Security.
 */
export const supabase: SupabaseClient = createClient(
  supabaseUrl,
  supabaseAnonKey,
  {
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  }
);

/**
 * Factory for a privileged client that bypasses Row Level Security.
 * SERVER ONLY: call from route handlers / server actions, never from
 * client components. The service role key must never reach the browser.
 */
export function getServiceSupabase(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("getServiceSupabase() must only be called on the server.");
  }

  const serviceRoleKey: string | undefined =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable."
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}