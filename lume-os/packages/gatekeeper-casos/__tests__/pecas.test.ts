import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { dataPorExtenso, montarCampos } from "../src/pecas/campos.js";
import { gerarDocx, inspecionarModelo, modeloPadrao } from "../src/pecas/modelo.js";
import { nomeDeArquivo } from "../src/casos.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function documento(docx: Uint8Array): string {
  return strFromU8(unzipSync(docx)["word/document.xml"]);
}

/** A template: the default one with document.xml (and optionally more parts) replaced. */
function modeloCom(corpo: string, extras: Record<string, string> = {}): Uint8Array {
  const arquivos = unzipSync(modeloPadrao());
  const doc = strFromU8(arquivos["word/document.xml"]);
  arquivos["word/document.xml"] = strToU8(doc.replace(/<w:body>[\s\S]*<w:sectPr>/, `<w:body>${corpo}<w:sectPr>`));
  for (const [nome, conteudo] of Object.entries(extras)) arquivos[nome] = strToU8(conteudo);
  return zipSync(arquivos);
}

const p = (...runs: string[]) => `<w:p>${runs.map((t) => `<w:r><w:t>${t}</w:t></w:r>`).join("")}</w:p>`;

describe("gerarDocx with the built-in template", () => {
  it("converts structure and emphasis, drops inline typography, and keeps a valid package", () => {
    const docx = gerarDocx(null, [
      "<h1>DOS FATOS</h1>",
      '<p style="font-family: Georgia; font-size: 30px; color: red">O autor, <b>correntista</b>, <i>constatou</i> &amp; <u>provou</u>.</p>',
      "<ol><li>primeiro<ul><li>aninhado</li></ul></li><li>segundo</li></ol>",
      "<blockquote>Art. 42 do CDC.</blockquote>",
      `<p style="text-align:right"><img src="data:image/png;base64,${PNG_1X1}" alt="Extrato"></p>`,
    ].join(""), {});
    const arquivos = unzipSync(docx);
    const xml = strFromU8(arquivos["word/document.xml"]);

    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain("<w:b/></w:rPr><w:t xml:space=\"preserve\">correntista");
    expect(xml).toContain("&amp; ");
    expect(xml).not.toMatch(/Georgia|FF0000|red/i);
    // Three list items: "primeiro", the nested "aninhado", "segundo".
    expect(xml.match(/<w:numPr>/g)).toHaveLength(3);
    expect(xml).toContain('<w:ilvl w:val="1"/>');
    expect(xml).toContain('<w:ind w:left="2268" w:firstLine="0"/>');
    expect(xml).toContain('<w:jc w:val="right"/>');
    expect(xml).toContain('r:embed="rIdLumeImagem1"');
    expect(xml).not.toContain("{{conteudo}}");

    expect(arquivos["word/media/lume-imagem-1.png"]).toBeDefined();
    expect(strFromU8(arquivos["word/_rels/document.xml.rels"])).toContain('Target="media/lume-imagem-1.png"');
    expect(strFromU8(arquivos["[Content_Types].xml"])).toContain('Extension="png"');
    const numeracao = strFromU8(arquivos["word/numbering.xml"]);
    // Schema order: every abstractNum before the first num.
    expect(numeracao.lastIndexOf("<w:abstractNum ")).toBeLessThan(numeracao.indexOf("<w:num "));
    expect(strFromU8(arquivos["[Content_Types].xml"])).toContain("/word/numbering.xml");
  });

  it("restarts numbering for every ordered list", () => {
    const xml = documento(gerarDocx(null, "<ol><li>a</li></ol><p>meio</p><ol><li>b</li></ol>", {}));
    const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
    expect(new Set(numIds).size).toBe(2);
  });
});

describe("gerarDocx with a firm template", () => {
  const campos = montarCampos(
    { cliente: { nome: "Maria & Filhos" }, numeroCnj: "0710802-55.2018.8.02.0001", tribunal: "TJAL" } as never,
    "Maceió",
    new Date("2026-09-24T15:00:00Z"),
  );

  it("fills fields, even split across runs or sharing one run, keeping the first run's formatting", () => {
    const modelo = modeloCom(
      `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>{{cli</w:t></w:r><w:r><w:t>ente}}, processo {{processo}}</w:t></w:r></w:p>` +
      p("{{cidade}}, {{data}} — {{desconhecido}}") +
      p("{{conteudo}}"),
    );
    const xml = documento(gerarDocx(modelo, "<p>Corpo</p>", campos));
    expect(xml).toContain('<w:b/></w:rPr><w:t xml:space="preserve">Maria &amp; Filhos</w:t>');
    expect(xml).toContain('<w:t xml:space="preserve">, processo 0710802-55.2018.8.02.0001</w:t>');
    expect(xml).toContain("Maceió, 24 de setembro de 2026 — {{desconhecido}}");
    expect(xml).toContain("Corpo");
    expect(xml).not.toContain("{{conteudo}}");
  });

  it("puts the piece at the end of the body when the template has no {{conteudo}}", () => {
    const xml = documento(gerarDocx(modeloCom(p("Cabeçalho do escritório") + p("Assinatura")), "<p>Corpo</p>", campos));
    expect(xml.indexOf("Assinatura")).toBeLessThan(xml.indexOf("Corpo"));
    expect(xml.indexOf("Corpo")).toBeLessThan(xml.indexOf("<w:sectPr>"));
  });

  it("keeps text around {{conteudo}} and fills fields in headers", () => {
    const modelo = modeloCom(p("Pedidos: {{conteudo}} fim"), {
      "word/header1.xml": `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${p("{{cidade}} {{conteudo}}")}</w:hdr>`,
    });
    const arquivos = unzipSync(gerarDocx(modelo, "<p>Corpo</p>", campos));
    const xml = strFromU8(arquivos["word/document.xml"]);
    // The paragraph keeps its text; the piece follows it.
    expect(xml).toContain("Pedidos:  fim");
    expect(xml.indexOf("Pedidos:  fim")).toBeLessThan(xml.indexOf("Corpo"));
    expect(strFromU8(arquivos["word/header1.xml"])).toContain("Maceió ");
  });

  it("uses the template's own heading styles, found by name, and merges into its numbering", () => {
    const estilos =
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:style w:type="paragraph" w:styleId="Ttulo1"><w:name w:val="heading 1"/></w:style></w:styles>';
    const numeracao =
      '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:abstractNum w:abstractNumId="7"/><w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num></w:numbering>';
    const modelo = modeloCom(p("{{conteudo}}"), { "word/styles.xml": estilos, "word/numbering.xml": numeracao });
    const arquivos = unzipSync(gerarDocx(modelo, "<h1>T</h1><h2>S</h2><ul><li>x</li></ul>", {}));
    const xml = strFromU8(arquivos["word/document.xml"]);
    expect(xml).toContain('<w:pStyle w:val="Ttulo1"/>');
    // No heading 2 style: bold body text instead.
    expect(xml).toMatch(/<w:b\/><\/w:rPr><w:t xml:space="preserve">S</);
    expect(xml).toContain('<w:numId w:val="4"/>');
    const numeracaoFinal = strFromU8(arquivos["word/numbering.xml"]);
    expect(numeracaoFinal).toContain('w:abstractNumId="8"');
    expect(numeracaoFinal.indexOf('w:abstractNumId="9"')).toBeLessThan(numeracaoFinal.indexOf('<w:num w:numId="3"'));
  });
});

describe("inspecionarModelo", () => {
  it("lists known fields and warns about the rest", () => {
    expect(inspecionarModelo(modeloCom(p("{{cliente}} {{ Processo }} {{assinatura}}")))).toEqual({
      campos: ["cliente", "processo"],
      avisos: [
        "O modelo não tem {{conteudo}}: a peça será inserida no fim do corpo.",
        "Campos desconhecidos ficarão como estão: {{assinatura}}.",
      ],
    });
  });

  it("rejects files that are not Word documents", () => {
    expect(() => inspecionarModelo(new TextEncoder().encode("%PDF-1.4"))).toThrow(/\.docx/);
    expect(() => inspecionarModelo(zipSync({ "a.txt": strToU8("x") }))).toThrow(/não é um documento do Word/);
    const macro = unzipSync(modeloPadrao());
    macro["word/vbaProject.bin"] = new Uint8Array([1]);
    expect(() => inspecionarModelo(zipSync(macro))).toThrow(/macros/);
  });
});

describe("campos", () => {
  it("writes the date in full in Brasília time and names files safely", () => {
    expect(dataPorExtenso(new Date("2026-01-01T01:00:00Z"))).toBe("31 de dezembro de 2025");
    expect(montarCampos(null, undefined, new Date("2026-09-24T15:00:00Z"))).toMatchObject({ cliente: "", cidade: "" });
    expect(nomeDeArquivo(' Petição: "inicial"/2026 ')).toBe("Petição inicial 2026");
    expect(nomeDeArquivo("///")).toBe("peca");
  });
});
