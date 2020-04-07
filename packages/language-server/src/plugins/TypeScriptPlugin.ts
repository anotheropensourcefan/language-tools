import ts, { NavigationTree } from 'typescript';
import {
    CodeAction,
    CodeActionContext,
    CompletionItem,
    CompletionList,
    DefinitionLink,
    Diagnostic,
    Document,
    Fragment,
    Hover,
    LocationLink,
    Position,
    Range,
    SymbolInformation,
    TextDocumentEdit,
    TextEdit,
    VersionedTextDocumentIdentifier,
    CodeActionsProvider,
    CompletionsProvider,
    DefinitionsProvider,
    DiagnosticsProvider,
    DocumentSymbolsProvider,
    HoverProvider,
    OnRegister,
    Resolvable,
} from '../api';
import { DocumentManager } from '../lib/documents/DocumentManager';
import { TextDocument } from '../lib/documents/TextDocument';
import { LSConfigManager, LSTypescriptConfig } from '../ls-config';
import { pathToUrl } from '../utils';
import { CreateDocument, getLanguageServiceForDocument } from './typescript/service';
import {
    convertRange,
    getCommitCharactersForScriptElement,
    getScriptKindFromAttributes,
    mapSeverity,
    scriptElementKindToCompletionItemKind,
    symbolKindFromString,
} from './typescript/utils';

export class TypeScriptPlugin
    implements
        OnRegister,
        DiagnosticsProvider,
        HoverProvider,
        DocumentSymbolsProvider,
        CompletionsProvider,
        DefinitionsProvider,
        CodeActionsProvider {
    public static matchFragment(fragment: Fragment) {
        return fragment.details.attributes.tag == 'script';
    }

    private configManager!: LSConfigManager;
    private createDocument!: CreateDocument;

    onRegister(docManager: DocumentManager, configManager: LSConfigManager) {
        this.configManager = configManager;
        this.createDocument = (fileName, content) => {
            const uri = pathToUrl(fileName);
            const document = docManager.openDocument({
                languageId: '',
                text: content,
                uri,
                version: 0,
            });
            docManager.lockDocument(uri);
            return document;
        };
    }

    getDiagnostics(document: Document): Diagnostic[] {
        if (!this.featureEnabled('diagnostics')) {
            return [];
        }

        const lang = getLanguageServiceForDocument(document, this.createDocument);
        const isTypescript =
            getScriptKindFromAttributes(document.getAttributes()) === ts.ScriptKind.TS;

        let diagnostics: ts.Diagnostic[] = [
            ...lang.getSyntacticDiagnostics(document.getFilePath()!),
            ...lang.getSuggestionDiagnostics(document.getFilePath()!),
            ...lang.getSemanticDiagnostics(document.getFilePath()!),
        ];

        return diagnostics.map(diagnostic => ({
            range: convertRange(document, diagnostic),
            severity: mapSeverity(diagnostic.category),
            source: isTypescript ? 'ts' : 'js',
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
            code: diagnostic.code,
        }));
    }

    doHover(document: Document, position: Position): Hover | null {
        if (!this.featureEnabled('hover')) {
            return null;
        }

        const lang = getLanguageServiceForDocument(document, this.createDocument);
        const info = lang.getQuickInfoAtPosition(
            document.getFilePath()!,
            document.offsetAt(position),
        );
        if (!info) {
            return null;
        }
        let contents = ts.displayPartsToString(info.displayParts);
        return {
            range: convertRange(document, info.textSpan),
            contents: { language: 'ts', value: contents },
        };
    }

    getDocumentSymbols(document: Document): SymbolInformation[] {
        if (!this.featureEnabled('documentSymbols')) {
            return [];
        }

        const lang = getLanguageServiceForDocument(document, this.createDocument);
        const navTree = lang.getNavigationTree(document.getFilePath()!);

        const symbols: SymbolInformation[] = [];
        collectSymbols(navTree, undefined, symbol => symbols.push(symbol));

        const topContainerName = symbols[0].name;
        return symbols.slice(1).map(symbol => {
            if (symbol.containerName === topContainerName) {
                return { ...symbol, containerName: 'script' };
            }

            return symbol;
        });

        function collectSymbols(
            tree: NavigationTree,
            container: string | undefined,
            cb: (symbol: SymbolInformation) => void,
        ) {
            const start = tree.spans[0];
            const end = tree.spans[tree.spans.length - 1];
            if (start && end) {
                cb(
                    SymbolInformation.create(
                        tree.text,
                        symbolKindFromString(tree.kind),
                        Range.create(
                            document.positionAt(start.start),
                            document.positionAt(end.start + end.length),
                        ),
                        document.getURL(),
                        container,
                    ),
                );
            }
            if (tree.childItems) {
                for (const child of tree.childItems) {
                    collectSymbols(child, tree.text, cb);
                }
            }
        }
    }

    getCompletions(
        document: Document,
        position: Position,
        triggerCharacter?: string,
    ): CompletionList | null {
        if (!this.featureEnabled('completions')) {
            return null;
        }

        const lang = getLanguageServiceForDocument(document, this.createDocument);
        // The language service throws an error if the character is not a valid trigger character.
        // Also, the completions are worse.
        // Therefore, only use the characters the typescript compiler treats as valid.
        const validTriggerCharacter = ['.', '"', "'", '`', '/', '@', '<', '#'].includes(
            triggerCharacter!,
        )
            ? triggerCharacter
            : undefined;
        const completions = lang.getCompletionsAtPosition(
            document.getFilePath()!,
            document.offsetAt(position),
            {
                includeCompletionsForModuleExports: true,
                triggerCharacter: validTriggerCharacter as any,
            },
        );

        if (!completions) {
            return null;
        }

        return CompletionList.create(
            completions!.entries.map(comp => {
                return <CompletionItem>{
                    label: comp.name,
                    kind: scriptElementKindToCompletionItemKind(comp.kind),
                    sortText: comp.sortText,
                    commitCharacters: getCommitCharactersForScriptElement(comp.kind),
                    preselect: comp.isRecommended,
                };
            }),
        );
    }

    getDefinitions(document: Document, position: Position): DefinitionLink[] {
        if (!this.featureEnabled('definitions')) {
            return [];
        }

        const lang = getLanguageServiceForDocument(document, this.createDocument);

        const defs = lang.getDefinitionAndBoundSpan(
            document.getFilePath()!,
            document.offsetAt(position),
        );

        if (!defs || !defs.definitions) {
            return [];
        }

        const docs = new Map<string, Document>([[document.getFilePath()!, document]]);

        return defs.definitions
            .map(def => {
                let defDoc = docs.get(def.fileName);
                if (!defDoc) {
                    defDoc = new TextDocument(
                        pathToUrl(def.fileName),
                        ts.sys.readFile(def.fileName) || '',
                    );
                    docs.set(def.fileName, defDoc);
                }

                return LocationLink.create(
                    pathToUrl(def.fileName),
                    convertRange(defDoc, def.textSpan),
                    convertRange(defDoc, def.textSpan),
                    convertRange(document, defs.textSpan),
                );
            })
            .filter(res => !!res) as DefinitionLink[];
    }

    getCodeActions(
        document: Document,
        range: Range,
        context: CodeActionContext,
    ): Resolvable<CodeAction[]> {
        if (!this.featureEnabled('codeActions')) {
            return [];
        }

        const lang = getLanguageServiceForDocument(document, this.createDocument);

        const start = document.offsetAt(range.start);
        const end = document.offsetAt(range.end);
        const errorCodes: number[] = context.diagnostics.map(diag => Number(diag.code));
        const codeFixes = lang.getCodeFixesAtPosition(
            document.getFilePath()!,
            start,
            end,
            errorCodes,
            {},
            {},
        );

        const docs = new Map<string, Document>([[document.getFilePath()!, document]]);
        return codeFixes.map(fix => {
            return CodeAction.create(
                fix.description,
                {
                    documentChanges: fix.changes.map(change => {
                        let doc = docs.get(change.fileName);
                        if (!doc) {
                            doc = new TextDocument(
                                pathToUrl(change.fileName),
                                ts.sys.readFile(change.fileName) || '',
                            );
                            docs.set(change.fileName, doc);
                        }

                        return TextDocumentEdit.create(
                            VersionedTextDocumentIdentifier.create(
                                pathToUrl(change.fileName),
                                null,
                            ),
                            change.textChanges.map(edit => {
                                return TextEdit.replace(
                                    convertRange(doc!, edit.span),
                                    edit.newText,
                                );
                            }),
                        );
                    }),
                },
                fix.fixName,
            );
        });
    }

    private featureEnabled(feature: keyof LSTypescriptConfig) {
        return (
            this.configManager.enabled('typescript.enable') &&
            this.configManager.enabled(`typescript.${feature}.enable`)
        );
    }
}
