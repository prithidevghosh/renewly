import { ulid } from "ulid";

/**
 * Prefixed ULIDs: lexicographically sortable by creation time and
 * self-describing in logs and URLs.
 */
export type IdPrefix =
  | "usr"
  | "wsp"
  | "wmb"
  | "sub"
  | "rev"
  | "imp"
  | "cnd"
  | "dec"
  | "pay"
  | "txn"
  | "rct"
  | "sav"
  | "evt"
  | "mch"
  | "chn"
  | "thr"
  | "msg"
  | "apr"
  | "job"
  | "obx"
  | "idm"
  | "eml"
  | "wlt";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
