// Adapter for the supplied #2283 case. The model chooses scenarios/expectations;
// this deterministic harness handles the repository's already-established Roslyn APIs.
export const harnessPath = 'tests/MessagePack.SourceGenerator.Tests/KatseScenarioHarness.cs';
export const harnessContent = `// Katse executable scenario adapter, based on the repository's test infrastructure.
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Testing;
using VerifyGenerator = CSharpSourceGeneratorVerifier<MessagePack.SourceGenerator.MessagePackGenerator>;
using VerifyAnalyzer = CSharpCodeFixVerifier<MessagePack.SourceGenerator.Analyzers.MsgPack00xMessagePackAnalyzer, MessagePack.Analyzers.CodeFixes.MessagePackCodeFixProvider>;

internal static class KatseScenarioHarness
{
    internal static async Task AnalyzerAsync(string source)
    {
        await new VerifyAnalyzer.Test
        {
            TestCode = source,
            MarkupOptions = MarkupOptions.UseFirstDescriptor,
        }.RunAsync();
    }

    internal static async Task MetadataAsync(string library, string source, string resolver, string? resolverSource = null)
    {
        var framework = await ReferenceAssemblies.Net.Net80.ResolveAsync(LanguageNames.CSharp, CancellationToken.None);
        var references = framework.Concat(ReferencesHelper.GetReferences(ReferencesSet.MessagePack)).ToArray();
        var parse = CSharpParseOptions.Default.WithLanguageVersion(LanguageVersion.Latest);
        var libraryCompilation = CSharpCompilation.Create("KatseLibrary", new[] { CSharpSyntaxTree.ParseText(library, parse) }, references, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var bytes = new MemoryStream();
        var emitted = libraryCompilation.Emit(bytes);
        Assert.True(emitted.Success, "KATSE_HARNESS_INVALID_LIBRARY: " + string.Join("\\n", emitted.Diagnostics));
        var metadata = MetadataReference.CreateFromImage(bytes.ToArray());
        var test = new VerifyGenerator.Test(ReferencesSet.MessagePack)
        {
            LanguageVersion = LanguageVersion.Latest,
            TestBehaviors = TestBehaviors.SkipGeneratedSourcesCheck,
            TestState = { Sources = { source } },
        };
        if (resolverSource is not null) test.TestState.Sources.Add(resolverSource);
        test.TestState.AdditionalReferences.Add(metadata);
        await test.RunAsync();
        var trees = new List<SyntaxTree> { CSharpSyntaxTree.ParseText(source, parse) };
        if (resolverSource is not null) trees.Add(CSharpSyntaxTree.ParseText(resolverSource, parse));
        var app = CSharpCompilation.Create("KatseApp", trees, references.Append(metadata), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var result = CSharpGeneratorDriver.Create(new MessagePack.SourceGenerator.MessagePackGenerator().AsSourceGenerator()).RunGenerators(app).GetRunResult();
        Assert.Empty(result.Diagnostics.Where(d => d.Severity >= DiagnosticSeverity.Warning));
        Assert.Contains(resolver, result.Results.SelectMany(r => r.GeneratedSources).Select(s => s.HintName));
    }
}
`;

export const scenarioInstructions = `Return JSON {"hypothesis":"possible failure", "scenario":"input explanation", "expected":"required outcome", "expectations":["E1"], "test":{"kind":"metadata|analyzer","library":"C# library source for metadata case", "source":"C# consuming/local source"}}.
Supported executable scenarios:
- metadata: library is compiled to a separate assembly. source uses it with [MessagePackObject]. Katse adds its own attributed resolver class in a separate syntax tree; do not declare a resolver or supply a resolver field. The repository verifier executes MessagePackGenerator AND all MessagePack diagnostic analyzers. The harness checks NO analyzer/generator errors and actual generation of its resolver. Use valid attributed types, members and [Key] attributes. A property name MUST differ from any nested type name in the same class. No assertions about runtime serialization.
- analyzer: source is checked by MsgPack00xMessagePackAnalyzer. Expected diagnostics use Roslyn markup, e.g. public int {|MsgPack004:Value|} { get; set; }. MarkupOptions.UseFirstDescriptor is configured. Include using MessagePack;. No library or resolver required. Keep source C# 7.3-compatible for this mode.
Describe the expected absence of exceptions and generation of the harness-owned resolver, without guessing a filename.
No tools. Do not output a C# test class, imports for the harness, or files. Only supply the small scenario sources. Do not assume unspecified metadata diagnostic policy.`;

const literal = s => '@"' + String(s || '').replaceAll('"', '""') + '"';
export function materializeScenario(attack, id) {
  let t = attack.test;
  if (!t || !['metadata', 'analyzer'].includes(t.kind) || typeof t.source !== 'string' || t.source.length > 12000) throw new Error('scenario-schema');
  if (t.kind === 'metadata' && (typeof t.library !== 'string' || t.library.length > 12000)) throw new Error('scenario-metadata-schema');
  const name = `Katse${id.replace(/[^a-zA-Z0-9]/g, '')}`;
  // Resolver setup is test infrastructure, not an adversarial decision. Keep it
  // in its own tree so model sources can use either file-scoped or block namespaces.
  if(t.kind==='metadata') t={kind:t.kind,library:t.library,source:t.source,resolver:`Katse.Generated.${name}Resolver.g.cs`,resolverSource:`namespace Katse.Generated { [global::MessagePack.GeneratedMessagePackResolver] public partial class ${name}Resolver { } }`,resolverSetup:'orchestrator'};
  const invoke = t.kind === 'metadata' ? `MetadataAsync(${literal(t.library)}, ${literal(t.source)}, ${literal(t.resolver)}, ${literal(t.resolverSource)})` : `AnalyzerAsync(${literal(t.source)})`;
  return { hypothesis: attack.hypothesis, scenario: attack.scenario, expected: attack.expected, expectations: attack.expectations, test: t, names: [name], files: [{ path: `tests/MessagePack.SourceGenerator.Tests/${name}.cs`, content: `public class ${name}Tests\n{\n    [Fact]\n    public async Task ${name}() => await KatseScenarioHarness.${invoke};\n}\n` }] };
}
