import { z } from "zod";
import { THINKING_LEVELS } from "./session.ts";

export const thinkingSchema = z.enum(THINKING_LEVELS);
