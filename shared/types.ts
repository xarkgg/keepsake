/**
 * The only shapes the server ever holds for an account.
 *
 * Keepsake is local-first: conversations, memory and everything else private
 * live on the device. What an account has server-side is an identity and a
 * profile, so these two types are the whole of the shared contract.
 */

export interface Profile {
  id: number;
  name: string | null;
  email: string | null;
  onboarded: number;
  created_at: string;
  has_avatar?: number;
}

export interface Account {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  last_login_at?: string | null;
  /** False for accounts that only sign in through Firebase (no local password). */
  has_password?: boolean;
}
