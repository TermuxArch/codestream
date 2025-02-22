"use strict";

import * as fs from "fs";
import { CodeStreamDiffUriData } from "@codestream/protocols/agent";
import { PullRequestCommentsChangedEvent } from "api/sessionEvents";
import {
	CancellationToken,
	ConfigurationChangeEvent,
	DecorationOptions,
	DecorationRangeBehavior,
	Disposable,
	Hover,
	HoverProvider,
	languages,
	MarkdownString,
	OverviewRulerLane,
	Position,
	Range,
	TextDocument,
	TextEditor,
	TextEditorDecorationType,
	Uri,
	window,
	workspace
} from "vscode";
import {
	DocMarker,
	SessionStatus,
	SessionStatusChangedEvent,
	TextDocumentMarkersChangedEvent
} from "../api/session";
import { OpenCodemarkCommandArgs, OpenPullRequestCommandArgs } from "../commands";
import { configuration } from "../configuration";
import { Container } from "../container";
import { Logger } from "../logger";
import { Functions, Strings } from "../system";
import * as csUri from "../system/uri";

const emptyArray = (Object.freeze([]) as any) as any[];

const positionStyleMap: { [key: string]: string } = {
	inline: "display: inline-block; margin: 0 0.5em 0 0; vertical-align: middle;",
	overlay:
		"display: inline-block; left: 0; position: absolute; top: 50%; transform: translateY(-50%)"
};

const buildDecoration = (position: string, type: string, color: string, _status: string) => {
	const pngPath = Container.context.asAbsolutePath(`assets/images/marker-${type}-${color}.png`);
	try {
		const pngBase64 = fs.readFileSync(pngPath, { encoding: "base64" });
		const pngInlineUrl = `data:image/png;base64,${pngBase64}`;

		return {
			contentText: "",
			height: "16px",
			width: "16px",

			textDecoration: `none; background-image: url(${pngInlineUrl}); background-position: center; background-repeat: no-repeat; background-size: contain; ${positionStyleMap[position]}`
		};
	} catch (e) {
		return;
	}
};

const MarkerPositions = ["inline", "overlay"];
const MarkerTypes = ["comment", "question", "issue", "trap", "bookmark", "prcomment"];
const MarkerColors = ["blue", "green", "yellow", "orange", "red", "purple", "aqua", "gray"];
const MarkerStatuses = ["open", "closed"];
const MarkerHighlights: { [key: string]: string } = {
	// blue: "rgba(53, 120, 186, .25)",
	// green: "rgba(122, 186, 93, .25)",
	// yellow: "rgba(237, 214, 72, .25)",
	// orange: "rgba(241, 163, 64, .25)",
	// red: "rgba(217, 99, 79, .25)",
	// purple: "rgba(184, 124, 218, .25)",
	// aqua: "rgba(90, 191, 220, .25)",
	// gray: "rgba(127, 127, 127, .25)"
	blue: "rgba(0, 110, 183, .25)",
	green: "rgba(88, 181, 71, .25)",
	yellow: "rgba(240, 208, 5, .25)",
	orange: "rgba(255, 147, 25, .25)",
	red: "rgba(232, 78, 62, .25)",
	purple: "rgba(187, 108, 220, .25)",
	aqua: "rgba(0, 186, 220, .25)",
	gray: "rgba(127, 127, 127, .25)"
};
const MarkerOverviewRuler: { [key: string]: string } = {
	blue: "rgb(0, 110, 183)",
	green: "rgb(88, 181, 71)",
	yellow: "rgb(240, 208, 5)",
	orange: "rgb(255, 147, 25)",
	red: "rgb(232, 78, 62)",
	purple: "rgb(187, 108, 220)",
	aqua: "rgb(0, 186, 220)",
	gray: "rgb(127, 127, 127)"
};

export class CodemarkDecorationProvider implements HoverProvider, Disposable {
	private _decorationTypes: { [key: string]: TextEditorDecorationType } | undefined;
	private readonly _disposable: Disposable;
	private _enabledDisposable: Disposable | undefined;

	private readonly _markersCache = new Map<string, Promise<DocMarker[]>>();
	private _watchedEditorsMap: Map<string, () => void> | undefined;

	private _suspended = false;

	constructor() {
		this._disposable = Disposable.from(
			configuration.onDidChange(this.onConfigurationChanged, this),
			Container.session.onDidChangeSessionStatus(this.onSessionStatusChanged, this)
		);

		this.onConfigurationChanged(configuration.initializingChangeEvent);
	}

	dispose() {
		this.disable();
		this._disposable && this._disposable.dispose();
	}

	suspend() {
		if (this._suspended || !Container.config.autoHideMarkers) return;

		this._suspended = true;
		this.ensure(true);
	}

	resume() {
		if (!this._suspended) return;

		this._suspended = false;
		this.ensure(true);
	}

	private onConfigurationChanged(e: ConfigurationChangeEvent) {
		if (configuration.changed(e, configuration.name("showMarkerGlyphs").value)) {
			this.ensure(true);
		}
	}

	private onSessionStatusChanged(e: SessionStatusChangedEvent) {
		switch (e.getStatus()) {
			case SessionStatus.SignedOut:
				this.disable();
				break;

			case SessionStatus.SignedIn: {
				const preferences = Container.session.user.preferences;
				if (preferences) {
					this._lastPreferences = {
						codemarksShowPRComments: !!preferences.codemarksShowPRComments,
						codemarksHideReviews: !!preferences.codemarksHideReviews,
						codemarksHideResolved: !!preferences.codemarksHideResolved,
						codemarksShowArchived: !!preferences.codemarksShowArchived
					};
				}
				this.ensure();
				break;
			}
		}
	}

	private ensure(reset: boolean = false) {
		if (!Container.config.showMarkerGlyphs || !Container.session.signedIn) {
			this.disable();

			return;
		}

		if (reset) {
			this.disable();
		}
		this.enable();
	}

	private disable() {
		if (this._enabledDisposable === undefined) return;

		this._markersCache.clear();
		for (const editor of this.getApplicableVisibleEditors()) {
			this.clear(editor);
		}

		this._enabledDisposable.dispose();
		this._enabledDisposable = undefined;
	}

	private enable() {
		if (
			this._enabledDisposable !== undefined ||
			Container.session.status !== SessionStatus.SignedIn
		) {
			return;
		}

		const decorationTypes: { [key: string]: TextEditorDecorationType } = Object.create(null);

		if (!this._suspended) {
			for (const position of MarkerPositions) {
				for (const type of MarkerTypes) {
					for (const color of MarkerColors) {
						for (const status of MarkerStatuses) {
							const key = `${position}-${type}-${color}-${status}`;
							const before = buildDecoration(position, type, color, status);
							if (before) {
								decorationTypes[key] = window.createTextEditorDecorationType({
									before
								});
							}
						}
					}
				}
			}
		}

		for (const color of MarkerColors) {
			decorationTypes[`overviewRuler-${color}`] = window.createTextEditorDecorationType({
				overviewRulerColor: MarkerOverviewRuler[color],
				overviewRulerLane: OverviewRulerLane.Center
			});

			decorationTypes[`trap-highlight-${color}`] = window.createTextEditorDecorationType({
				rangeBehavior: DecorationRangeBehavior.OpenOpen,
				isWholeLine: true,
				backgroundColor: MarkerHighlights[color]
			});
		}

		this._decorationTypes = decorationTypes;

		const subscriptions: Disposable[] = [
			...Object.values(decorationTypes),
			Container.session.onDidChangeTextDocumentMarkers(this.onMarkersChanged, this),
			Container.session.onDidChangePullRequestComments(this.onPullRequestCommentsChanged, this),
			Container.session.onDidChangeSessionStatus(this.onSessionStatusChanged, this),
			window.onDidChangeVisibleTextEditors(this.onEditorVisibilityChanged, this),
			workspace.onDidCloseTextDocument(this.onDocumentClosed, this),
			Container.session.onDidChangePreferences(e => {
				const preferences = e.preferences();
				const currentPreferences = {
					codemarksShowPRComments: !!preferences.codemarksShowPRComments,
					codemarksHideReviews: !!preferences.codemarksHideReviews,
					codemarksHideResolved: !!preferences.codemarksHideResolved,
					codemarksShowArchived: !!preferences.codemarksShowArchived
				};
				if (JSON.stringify(currentPreferences) !== JSON.stringify(this._lastPreferences)) {
					// set the reset flag to true if we need to re-fetch
					this.ensure(true);
				}
				this._lastPreferences = currentPreferences;
			}, this)
		];

		if (!this._suspended) {
			subscriptions.push(languages.registerHoverProvider({ scheme: "file" }, this));
			subscriptions.push(languages.registerHoverProvider({ scheme: "codestream-diff" }, this));
			subscriptions.push(languages.registerHoverProvider({ scheme: "codestream-git" }, this));
		}

		this._enabledDisposable = Disposable.from(...subscriptions);

		this.applyToApplicableVisibleEditors();
	}

	private _lastPreferences?: {
		codemarksShowPRComments?: boolean;
		codemarksHideReviews?: boolean;
		codemarksHideResolved?: boolean;
		codemarksShowArchived?: boolean;
	};

	private async onDocumentClosed(e: TextDocument) {
		this._markersCache.delete(e.uri.toString());
	}

	private async onEditorVisibilityChanged(e: TextEditor[]) {
		this.applyToApplicableVisibleEditors(e);
	}

	private onMarkersChanged(e: TextDocumentMarkersChangedEvent) {
		const uri = e.uri.toString();
		this._markersCache.delete(uri);
		const fsPath = Uri.parse(uri).fsPath;
		for (const key of this._markersCache.keys()) {
			const keyFsPath = Uri.parse(key).fsPath;
			if (keyFsPath === fsPath) {
				this._markersCache.delete(key);
			}
		}

		const editors = this.getApplicableVisibleEditors().filter(e => e.document.uri.fsPath === fsPath);
		for (const editor of editors) {
			this.apply(editor);
		}
	}

	private onPullRequestCommentsChanged(_e: PullRequestCommentsChangedEvent) {
		const editors = this.getApplicableVisibleEditors();
		const diffEditors = editors.filter(e => e.document.uri.scheme === "codestream-diff");
		for (const editor of diffEditors) {
			this.apply(editor, true);
		}
	}

	async apply(editor: TextEditor | undefined, force: boolean = false) {
		if (
			this._decorationTypes === undefined ||
			!Container.session.signedIn ||
			!this.isApplicableEditor(editor)
		) {
			return;
		}

		if (force) this._markersCache.delete(editor!.document.uri.toString());

		const decorations = await this.provideDecorations(editor!);
		if (Object.keys(decorations).length === 0) {
			this.clear(editor);
			return;
		}

		for (const [key, value] of Object.entries(this._decorationTypes)) {
			editor!.setDecorations(value, (decorations[key] as any) || emptyArray);
		}
	}

	applyToApplicableVisibleEditors(editors = window.visibleTextEditors) {
		const editorsToWatch = new Map<string, () => void>();

		for (const e of this.getApplicableVisibleEditors(editors)) {
			const key = e.document.uri.toString();
			editorsToWatch.set(
				key,
				(this._watchedEditorsMap && this._watchedEditorsMap.get(key)) ||
					Functions.debounce(() => this.apply(e, true), 1000)
			);

			this.apply(e);
		}

		this._watchedEditorsMap = editorsToWatch;
	}

	clear(editor: TextEditor | undefined = window.activeTextEditor) {
		if (editor === undefined || this._decorationTypes === undefined) return;

		for (const decoration of Object.values(this._decorationTypes)) {
			editor.setDecorations(decoration, emptyArray);
		}
	}

	async provideDecorations(
		editor: TextEditor
	): Promise<{ [key: string]: (DecorationOptions | Range)[] }> {
		const markers = await this.getMarkers(editor.document.uri);
		// Logger.warn(`GOT SOME MARKERS: ${JSON.stringify(markers, null, 4)}`);

		if (markers.length === 0) return {};

		const decorations: { [key: string]: (DecorationOptions | Range)[] } = {};

		const starts = new Set();
		for (const marker of markers) {
			const start = marker.range.start.line;
			if (starts.has(start)) continue;

			if (marker.type === "trap") {
				const trapKey = `trap-highlight-${marker.color}`;
				if (!decorations[trapKey]) {
					decorations[trapKey] = [];
				}

				decorations[trapKey].push(
					new Range(
						marker.range.start.line,
						marker.range.start.character,
						marker.range.end.line,
						1000000
					)
				);
			}

			const overviewRulerKey = `overviewRuler-${marker.color}`;
			if (!decorations[overviewRulerKey]) {
				decorations[overviewRulerKey] = [];
			}

			decorations[overviewRulerKey].push(marker.hoverRange);

			if (!this._suspended) {
				// && marker.codemarkId != null) {
				// Determine if the marker needs to be inline (i.e. part of the content or overlayed)
				let position = "inline";
				try {
					position =
						editor.document.lineAt(start).firstNonWhitespaceCharacterIndex === 0
							? "inline"
							: "overlay";
				} catch (e) {
					Logger.error(e);
				}

				const key = `${position}-${marker.type}-${marker.color}-${marker.status}`;
				if (!decorations[key]) {
					decorations[key] = [];
				}

				decorations[key].push({
					range: marker.hoverRange, // editor.document.validateRange(marker.hoverRange)
					renderOptions: {}
				});
			}

			starts.add(start);
		}

		return decorations;
	}

	private _hoverPromise: Promise<Hover | undefined> | undefined;
	async provideHover(
		document: TextDocument,
		position: Position,
		token: CancellationToken
	): Promise<Hover | undefined> {
		if (Container.session.status !== SessionStatus.SignedIn) return undefined;

		const markers = await this.getMarkers(document.uri);
		if (markers.length === 0 || token.isCancellationRequested) return undefined;

		const hoveredMarkers = markers.filter(
			m => m.hoverRange.contains(position) // document.validateRange(m.hoverRange).contains(position)
		);
		if (hoveredMarkers.length === 0) return undefined;

		// Make sure we don't start queuing up requests to get the hovers
		if (this._hoverPromise !== undefined) {
			void (await this._hoverPromise);
			if (token.isCancellationRequested) return undefined;
		}

		this._hoverPromise = this.provideHoverCore(document, hoveredMarkers, token);
		return this._hoverPromise;
	}

	async provideHoverCore(
		document: TextDocument,
		markers: DocMarker[],
		token: CancellationToken
	): Promise<Hover | undefined> {
		try {
			let message = "";
			let range = undefined;

			const { uri } = document;

			for (const m of markers) {
				try {
					if (token.isCancellationRequested) return undefined;
					if (m.codemarkId == null && m.externalContent == null) continue;

					if (range) {
						message += "\n\n-----\n\n";
					}

					if (m.codemarkId) {
						const viewCommandArgs: OpenCodemarkCommandArgs = {
							codemarkId: m.codemarkId,
							sourceUri: uri
						};

						let inReplyTo = "";
						const typeString = Strings.toTitleCase(m.type);
						message += `__${m.creatorName}__, ${m.fromNow()} \n\n`;
						switch (true) {
							case m.type === "issue":
								message += "  $(bug) ";
								break;
							case m.type === "comment" && m.isReviewDescendant && !!m.title:
								inReplyTo = `\n\n  __FEEDBACK REQUEST__ \n\n  $(search) ${m.title} \n\n`;
								break;
							default:
								// message += "  $(comment) ";
								break;
						}
						message += ` ${
							m.summaryMarkdown
						} \n\n${inReplyTo}[__View ${typeString} \u2197__](command:codestream.openCodemark?${encodeURIComponent(
							JSON.stringify(viewCommandArgs)
						)} "View ${typeString}")`;

						// &nbsp; &middot; &nbsp; [__Unpin Marker \u1F4CC__](command:codestream.openStream?${encodeURIComponent(
						// 	JSON.stringify(args)
						// )} "Unpin Marker")
					} else if (m.externalContent && m.externalContent.provider) {
						const { externalContent } = m;
						const viewCommandArgs: OpenPullRequestCommandArgs = {
							providerId: externalContent.provider.id,
							pullRequestId: externalContent.externalId!,
							commentId: externalContent.externalChildId,
							sourceUri: uri
						};

						const isGitHub = ["github*com", "github/enterprise"].includes(
							m.externalContent.provider.id
						);
						const isGitLab = ["gitlab*com", "gitlab/enterprise"].includes(
							m.externalContent.provider.id
						);
						let typeString = "Comment";
						if (m.type === "prcomment") {
							if (isGitLab) {
								typeString = "MR Comment";
							} else {
								typeString = "PR Comment";
							}
						}
						message += `__${m.creatorName}__, ${m.fromNow()} \n\n ${m.summaryMarkdown} \n\n __${
							isGitLab ? "MERGE" : "PULL"
						} REQUEST__\n\n`;
						if (isGitHub) {
							message += "  $(github-inverted) ";
						}
						message += m.title ? m.title : "";
						if (isGitHub || isGitLab) {
							message += ` \n\n[__View ${typeString} \u2197__](command:codestream.openPullRequest?${encodeURIComponent(
								JSON.stringify(viewCommandArgs)
							)} "View ${typeString}")`;
						}

						if (m.externalContent.actions && m.externalContent.actions.length) {
							m.externalContent.actions.map(action => {
								if (action.label === "Open Comment" || action.label === "Open Note") {
									viewCommandArgs.externalUrl = action.uri;
									message += ` \n\n[__View ${typeString} \u2197__](command:codestream.openPullRequest?${encodeURIComponent(
										JSON.stringify(viewCommandArgs)
									)} "View ${typeString}")`;
								}
							});
						}

						// TODO: Add actions from the external content
						// message += `__${m.creatorName}__, ${m.fromNow()} &nbsp; _(${m.formatDate()})_ ${
						// 	m.summaryMarkdown
						// }`;
					}

					if (range) {
						range.union(m.hoverRange); // document.validateRange(m.hoverRange));
					} else {
						range = m.hoverRange; // document.validateRange(m.hoverRange);
					}
				} catch (ex) {
					Logger.error(ex);
				}
			}

			if (message === undefined || range === undefined) return undefined;

			const markdown = new MarkdownString(message, true);
			markdown.isTrusted = true;

			return new Hover(markdown, range);
		} finally {
			this._hoverPromise = undefined;
		}
	}

	private getApplicableVisibleEditors(editors = window.visibleTextEditors) {
		return editors.filter(this.isApplicableEditor);
	}

	private async getMarkers(uri: Uri) {
		const uriKey = uri.toString();

		let markersPromise = this._markersCache.get(uriKey);
		if (markersPromise === undefined) {
			markersPromise = this.getMarkersCore(uri);
			this._markersCache.set(uriKey, markersPromise);
		}

		return markersPromise;
	}

	private async getMarkersCore(uri: Uri) {
		try {
			const { fileUri, sha } = csUri.Uris.getFileUriAndSha(uri);
			const resp = await Container.agent.documentMarkers.fetch(fileUri, sha);
			if (resp === undefined) return emptyArray;

			return resp.markers.map(m => new DocMarker(Container.session, m));
		} catch (ex) {
			Logger.error(ex);
			return emptyArray;
		}
	}

	private isApplicableEditor(editor: TextEditor | undefined) {
		if (!editor || !editor.document) return false;

		if (editor.document.uri.scheme === "file" || editor.document.uri.scheme === "codestream-git") return true;

		// check for review diff
		const parsedUri = Strings.parseCSReviewDiffUrl(editor.document.uri.toString());
		if (parsedUri) {
			return parsedUri.version === "right";
		}

		// check for PR diff
		const codeStreamDiff = csUri.Uris.fromCodeStreamDiffUri<CodeStreamDiffUriData>(
			editor.document.uri.toString()
		);
		if (codeStreamDiff) {
			return codeStreamDiff.side === "right";
		}

		return false;
	}
}
