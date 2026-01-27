import { rescanNotesForOwner as sdkRescanNotesForOwner } from "../../../sdk/src/noteScanner";
import { VIEW_KEY_SCAN_MAX_INDEX } from "./config";

export async function rescanNotesForOwner(
  params: Parameters<typeof sdkRescanNotesForOwner>[0]
) {
  if (
    params.viewKeyMaxIndex === undefined &&
    (!params.viewKeyIndices || params.viewKeyIndices.length === 0)
  ) {
    return sdkRescanNotesForOwner({
      ...params,
      viewKeyMaxIndex: VIEW_KEY_SCAN_MAX_INDEX,
    });
  }
  return sdkRescanNotesForOwner(params);
}
