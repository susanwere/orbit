declare module "pdf-parse" {
  export default function parsePdf(
    data: Buffer,
    options?: { max?: number },
  ): Promise<{ text: string; numpages: number }>;
}
