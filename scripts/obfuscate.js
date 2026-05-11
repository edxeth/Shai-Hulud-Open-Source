import JavaScriptObfuscator from "javascript-obfuscator";

const code = await Bun.file("./dist/bundle.js").text();
const obfuscated = JavaScriptObfuscator.obfuscate(code, {
  compact: true,
  controlFlowFlattening: true,
  stringArray: true,
  stringArrayEncoding: ["base64"],
}).getObfuscatedCode();

await Bun.write("./dist/bundle_obf.js", obfuscated);
