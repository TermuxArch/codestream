"use strict";
import {
	CancellationToken,
	CodeActionContext,
	CodeActionProvider,
	Command,
	Disposable,
	DocumentSelector,
	languages,
	Range,
	TextDocument
} from "vscode";
import { SessionStatus, SessionStatusChangedEvent } from "../api/session";
import { Container } from "../container";

export class CodeStreamCodeActionProvider implements CodeActionProvider, Disposable {
	static selector: DocumentSelector = [
		{ scheme: "file" },
		{ scheme: "untitled" },
		{ scheme: "vsls" }
	];

	private readonly _disposable: Disposable;
	private _disposableSignedIn: Disposable | undefined;

	constructor() {
		this._disposable = Disposable.from(
			Container.session.onDidChangeSessionStatus(this.onSessionStatusChanged, this)
		);
	}

	dispose() {
		this._disposable && this._disposable.dispose();
	}

	private async onSessionStatusChanged(e: SessionStatusChangedEvent) {
		const status = e.getStatus();
		switch (status) {
			case SessionStatus.SignedOut:
				this._disposableSignedIn && this._disposableSignedIn.dispose();
				break;

			case SessionStatus.SignedIn:
				this._disposableSignedIn = languages.registerCodeActionsProvider(
					CodeStreamCodeActionProvider.selector,
					this
				);
				break;
		}
	}

	provideCodeActions(
		document: TextDocument,
		range: Range,
		context: CodeActionContext,
		token: CancellationToken
	): Command[] | Thenable<Command[]> {
		if (!Container.session.signedIn || range.start.compareTo(range.end) === 0) return [];

		const commands: Command[] = [
			{
				title: `Get Permalink`,
				command: "codestream.newLink"
			},
			{
				title: `Add Comment`,
				command: "codestream.newComment"
			},
			{
				title: `Create Issue`,
				command: "codestream.newIssue"
			},
			{
				title: `Create Bookmark`,
				command: "codestream.newBookmark"
			}
		];
		return commands;
	}
}
