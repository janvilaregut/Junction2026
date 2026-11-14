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

    internal static async Task MetadataAsync(string library, string source, string resolver)
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
        test.TestState.AdditionalReferences.Add(metadata);
        await test.RunAsync();
        var app = CSharpCompilation.Create("KatseApp", new[] { CSharpSyntaxTree.ParseText(source, parse) }, references.Append(metadata), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var result = CSharpGeneratorDriver.Create(new MessagePack.SourceGenerator.MessagePackGenerator().AsSourceGenerator()).RunGenerators(app).GetRunResult();
        Assert.Empty(result.Diagnostics.Where(d => d.Severity >= DiagnosticSeverity.Warning));
        Assert.Contains(resolver, result.Results.SelectMany(r => r.GeneratedSources).Select(s => s.HintName));
    }
}
`;

export const scenarioInstructions = `Return JSON {"hypothesis":"possible failure", "scenario":"input explanation", "expected":"required outcome", "expectations":["E1"], "test":{"kind":"metadata|analyzer","library":"C# library source for metadata case", "source":"C# consuming/local source", "resolver":"Namespace.MyResolver.g.cs for metadata case"}}.
Supported executable scenarios:
- metadata: library is compiled to a separate assembly. source uses it with [MessagePackObject] and a [GeneratedMessagePackResolver] partial class. The repository verifier executes MessagePackGenerator AND all MessagePack diagnostic analyzers. The harness checks NO analyzer/generator errors and actual resolver generation. Use valid attributed types, members and [Key] attributes. A property name MUST differ from any nested type name in the same class. No assertions about runtime serialization.
- analyzer: source is checked by MsgPack00xMessagePackAnalyzer. Expected diagnostics use Roslyn markup, e.g. public int {|MsgPack004:Value|} { get; set; }. MarkupOptions.UseFirstDescriptor is configured. Include using MessagePack;. No library or resolver required. Keep source C# 7.3-compatible for this mode.
For metadata the resolver field is MANDATORY and NONEMPTY: source namespace App plus class MyResolver gives App.MyResolver.g.cs; a class MyResolver in the global namespace gives MyResolver.g.cs.
No tools. Do not output a C# test class, imports for the harness, or files. Only supply the small scenario sources. Do not assume unspecified metadata diagnostic policy.`;

const literal = s => '@"' + String(s || '').replaceAll('"', '""') + '"';
export function materializeScenario(attack, id) {
  const t = attack.test;
  if (!t || !['metadata', 'analyzer'].includes(t.kind) || typeof t.source !== 'string' || t.source.length > 12000) throw new Error('scenario-schema');
  if (t.kind === 'metadata' && (typeof t.library !== 'string' || t.library.length > 12000 || !/^[\w.]+\.g\.cs$/.test(t.resolver || ''))) throw new Error('scenario-metadata-schema');
  const name = `Katse${id.replace(/[^a-zA-Z0-9]/g, '')}`;
  const invoke = t.kind === 'metadata' ? `MetadataAsync(${literal(t.library)}, ${literal(t.source)}, ${literal(t.resolver)})` : `AnalyzerAsync(${literal(t.source)})`;
  return { hypothesis: attack.hypothesis, scenario: attack.scenario, expected: attack.expected, expectations: attack.expectations, test: t, names: [name], files: [{ path: `tests/MessagePack.SourceGenerator.Tests/${name}.cs`, content: `public class ${name}Tests\n{\n    [Fact]\n    public async Task ${name}() => await KatseScenarioHarness.${invoke};\n}\n` }] };
}
