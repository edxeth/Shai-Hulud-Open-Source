import type { ProviderResult } from "../providers/types";
import { Sender } from "./base";

export interface SenderFactory {
  tryCreate(quickRef?: ProviderResult[]): Promise<Sender | null>;
}
