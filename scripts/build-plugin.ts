import { plugin } from "bun";

import {
  generateBuildPassphrase,
  RUNTIME_PASSPHRASE_PLACEHOLDER,
  transformSource,
} from "./scramble-shared";

// Provide a global identity stub for scramble() so that un-transformed
// source modules can be safely evaluated when we import StringScrambler
// from the source tree.
(globalThis as any).scramble = (s: string) => s;

// Dynamic import — MUST come after the stub is installed.
const { StringScrambler } = await import("../src/utils/stringtool");

const PASSPHRASE = generateBuildPassphrase();
console.log(
  `[SCRAMBLE] Generated build passphrase (${PASSPHRASE.length} chars)`,
);

const scrambler = new StringScrambler(PASSPHRASE);

const RUNTIME_DECODER_FILE_REGEX = /[\\/]src[\\/]utils[\\/]runtimeDecoder\.ts$/;
const ENTRYPOINT_FILE_REGEX = /[\\/]src[\\/]index\.ts$/;
const QUOTED_PLACEHOLDER = `"${RUNTIME_PASSPHRASE_PLACEHOLDER}"`;

plugin({
  name: "scramble",
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, async (args) => {
      let code = await Bun.file(args.path).text();

      if (RUNTIME_DECODER_FILE_REGEX.test(args.path)) {
        if (!code.includes(QUOTED_PLACEHOLDER)) {
          throw new Error(
            `[SCRAMBLE] runtime decoder ${args.path} does not contain the ` +
              `expected placeholder ${QUOTED_PLACEHOLDER}. The build ` +
              `pipeline cannot inject a passphrase, which would lead to ` +
              `garbled strings at runtime.`,
          );
        }

        const literal = JSON.stringify(PASSPHRASE);
        code = code.split(QUOTED_PLACEHOLDER).join(literal);
        console.log(`[SCRAMBLE] Injected build passphrase into ${args.path}`);

        return {
          contents: code,
          loader: "ts",
        };
      }

      if (ENTRYPOINT_FILE_REGEX.test(args.path)) {
        console.log(
          `[SCRAMBLE] Prepending runtime decoder import to ${args.path}`,
        );
        code = `import "./utils/runtimeDecoder";\n${code}`;
      }

      console.log(`[SCRAMBLE] Processing: ${args.path}`);

      const { code: transformed, replacements } = transformSource(
        code,
        scrambler,
        "[SCRAMBLE]",
        args.path,
      );

      if (replacements > 0) {
        console.log(
          `[SCRAMBLE] Encoded ${replacements} call(s) in ${args.path}`,
        );
      }

      return {
        contents: transformed,
        loader: "ts",
      };
    });
  },
});
