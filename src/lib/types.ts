export type { Account, Profile } from "../../shared/types";

export interface Bootstrap {
  profile: import("../../shared/types").Profile;
  account: import("../../shared/types").Account;
  onboarded: boolean;
  /** Public Firebase web config, so inference works after a reload too. */
  firebase?: import("./firebase").FirebaseWebConfig | null;
}
