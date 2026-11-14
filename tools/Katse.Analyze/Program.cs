using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

// A deterministic reachability probe in a disposable runner copy. Never the source checkout.
using var request = JsonDocument.Parse(File.ReadAllText(args[0]));
if (request.RootElement.TryGetProperty("syntaxOnly", out var syntaxOnly) && syntaxOnly.GetBoolean()) {
    var root = request.RootElement.GetProperty("root").GetString()!;
    var errors = request.RootElement.GetProperty("files").EnumerateArray().Select(x=>x.GetString()!).Where(f=>File.Exists(Path.Combine(root,f)))
        .SelectMany(f=>CSharpSyntaxTree.ParseText(File.ReadAllText(Path.Combine(root,f)),path:f).GetDiagnostics().Where(d=>d.Severity==DiagnosticSeverity.Error).Select(d=>d.ToString())).Take(8).ToArray();
    Console.WriteLine(JsonSerializer.Serialize(new { errors }));
    if(errors.Length>0) Environment.ExitCode=2;
    return;
}
if (request.RootElement.TryGetProperty("probe", out var probe)) {
    var root = Path.GetFullPath(request.RootElement.GetProperty("root").GetString()!);
    var file = Path.GetFullPath(Path.Combine(root, probe.GetProperty("file").GetString()!));
    if (!file.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("Probe outside runner");
    var syntax = CSharpSyntaxTree.ParseText(File.ReadAllText(file)).GetRoot();
    var line = probe.GetProperty("start").GetInt32();
    var methods = syntax.DescendantNodes().Where(n => n is MethodDeclarationSyntax or ConstructorDeclarationSyntax)
        .Where(n => n.GetLocation().GetLineSpan().StartLinePosition.Line + 1 == line).ToArray();
    if (methods.Length != 1) throw new Exception("Probe requires one exact method or constructor declaration");
    var node = methods[0];
    var body = node is MethodDeclarationSyntax method ? method.Body : ((ConstructorDeclarationSyntax)node).Body;
    var expression = node is MethodDeclarationSyntax expressionMethod ? expressionMethod.ExpressionBody?.Expression : null;
    if (body == null && expression == null) throw new Exception("Method has no executable body");
    var marker = probe.GetProperty("marker").GetString()!;
    if (!System.Text.RegularExpressions.Regex.IsMatch(marker, "^KATSE_PROBE_[a-f0-9]+$")) throw new Exception("Invalid probe marker");
    var replacement = SyntaxFactory.ParseStatement("{ throw new global::System.InvalidOperationException(\"" + marker + "\"); }");
    SyntaxNode target = (SyntaxNode?)body ?? expression!;
    SyntaxNode failure = body != null ? replacement : SyntaxFactory.ParseExpression("throw new global::System.InvalidOperationException(\"" + marker + "\")");
    File.WriteAllText(file, syntax.ReplaceNode(target, failure).ToFullString());
    Console.WriteLine(JsonSerializer.Serialize(new { status = "instrumented", file, line, marker }));
    return;
}

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
