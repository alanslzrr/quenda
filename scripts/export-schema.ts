import {
  reservationExportExample,
  reservationExportSchema,
} from "../src/modules/communications/export-schema.ts";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--example"))
  throw new Error("Usage: export-schema.ts [--example]");
process.stdout.write(
  `${JSON.stringify(args[0] === "--example" ? reservationExportExample : reservationExportSchema, null, 2)}\n`,
);
