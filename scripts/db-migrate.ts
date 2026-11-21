import { migrate } from "@pw-support/db";

const applied = await migrate();
console.log(
  applied.length === 0
    ? "[db:migrate] up to date"
    : `[db:migrate] applied ${applied.length}: ${applied.join(", ")}`,
);
