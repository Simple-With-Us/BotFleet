import { z } from "zod";

export const fakeAcpConfigCallSchema = z
  .object({
    method: z.string(),
    params: z.unknown(),
  })
  .strict();

export const fakeAcpConfigCallFileSchema = z.array(fakeAcpConfigCallSchema);

export type FakeAcpConfigCall = z.infer<typeof fakeAcpConfigCallSchema>;
