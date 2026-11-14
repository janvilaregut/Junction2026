using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

var input = JsonSerializer.Deserialize<Input>(File.ReadAllText(args[0]))!;
var trees = input.files.Where(p => p.EndsWith(".cs") && File.Exists(Path.Combine(input.root, p)))
    .Select(p => CSharpSyntaxTree.ParseText(File.ReadAllText(Path.Combine(input.root, p)), path: p)).ToArray();
var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
    .Select(p => MetadataReference.CreateFromFile(p));
var compilation = CSharpCompilation.Create("KatseScope", trees, references,
    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
var found = new List<object>();
foreach (var change in input.changes) {
    var tree = trees.FirstOrDefault(t => t.FilePath == change.file);
    if (tree is null) continue;
    var model = compilation.GetSemanticModel(tree);
    var nodes = tree.GetRoot().DescendantNodes().Where(n => n is MethodDeclarationSyntax or ConstructorDeclarationSyntax or PropertyDeclarationSyntax);
    foreach (var node in nodes) {
        var span = node.GetLocation().GetLineSpan(); var start = span.StartLinePosition.Line + 1; var end = span.EndLinePosition.Line + 1;
        if (!change.lines.Any(l => l >= start && l <= end)) continue;
        var symbol = model.GetDeclaredSymbol(node);
        var refs = new List<object>();
        if (symbol != null) foreach (var other in trees) {
            var otherModel = compilation.GetSemanticModel(other);
            foreach (var name in other.GetRoot().DescendantNodes().OfType<SimpleNameSyntax>().Where(n => n.Identifier.ValueText == symbol.Name)) {
                var info = otherModel.GetSymbolInfo(name);
                if (SymbolEqualityComparer.Default.Equals(info.Symbol?.OriginalDefinition, symbol.OriginalDefinition))
                    refs.Add(new { file = other.FilePath, line = name.GetLocation().GetLineSpan().StartLinePosition.Line + 1, verified = true });
            }
        }
        found.Add(new { file = change.file, start, end, name = symbol?.ToDisplayString() ?? node.Kind().ToString(),
            conditions = node.DescendantNodes().OfType<IfStatementSyntax>().Where(n => {
                var range = n.GetLocation().GetLineSpan();
                return change.lines.Any(l => l >= range.StartLinePosition.Line + 1 && l <= range.EndLinePosition.Line + 1);
            }).Select(n => n.Condition.ToString()).Take(16),
            references = refs.Take(60), referenceCount = refs.Count, binding = symbol == null ? "unresolved" : "partial-compilation" });
    }
}
Console.WriteLine(JsonSerializer.Serialize(new { symbols = found, parsedFiles = trees.Length,
    limitation = "Bounded source compilation with runtime references; missing project dependencies and preprocessor configurations may leave references unresolved. Not whole-program analysis." }));
record Change(string file, int[] lines);
record Input(string root, string[] files, Change[] changes);
