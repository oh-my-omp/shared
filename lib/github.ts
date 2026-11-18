// The GitHub REST calls the push sync makes, with the installation token of the org's sync App. Every call is a
// plain `fetch`; a non-2xx answer other than the 404s the callers ask about is thrown as `GitHubError`, which the
// sync turns into a per-repository failure line.

import { z } from "zod";

const API = "https://api.github.com";

export class GitHubError extends Error {
	constructor(
		readonly status: number,
		readonly method: string,
		readonly path: string,
		detail: string,
	) {
		super(`${method} ${path} → ${status}: ${detail}`);
	}
}

const SHA = z.object({ sha: z.string() });
const REF = z.object({ ref: z.string() });
const PULL = z.object({ number: z.number(), html_url: z.string() });

export type Repository = { readonly name: string; readonly archived: boolean; readonly defaultBranch: string };
export type PullRequest = { readonly number: number; readonly url: string };
export type TreeEntry = { readonly path: string; readonly content: string };

export class GitHub {
	constructor(
		private readonly token: string,
		readonly owner: string,
	) {}

	private async call(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> {
		const response = await fetch(`${API}${path}`, {
			method,
			headers: {
				accept,
				authorization: `Bearer ${this.token}`,
				"x-github-api-version": "2022-11-28",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return response;
	}

	private async json<S extends z.ZodType>(schema: S, method: string, path: string, body?: unknown): Promise<z.infer<S>> {
		const response = await this.call(method, path, body);
		if (!response.ok) throw new GitHubError(response.status, method, path, await response.text());
		return schema.parse(await response.json());
	}

	/** Every repository of the owner organization. */
	async repositories(): Promise<Repository[]> {
		const out: Repository[] = [];
		for (let page = 1; ; page++) {
			const batch = await this.json(
				z.array(z.object({ name: z.string(), archived: z.boolean(), default_branch: z.string() })),
				"GET",
				`/orgs/${this.owner}/repos?type=all&per_page=100&page=${page}`,
			);
			out.push(...batch.map((r) => ({ name: r.name, archived: r.archived, defaultBranch: r.default_branch })));
			if (batch.length < 100) return out;
		}
	}

	/** The commit a branch points at, or null when the branch does not exist. */
	async branchHead(repo: string, branch: string): Promise<{ commit: string; tree: string } | null> {
		const response = await this.call("GET", `/repos/${this.owner}/${repo}/branches/${encodeURIComponent(branch)}`);
		if (response.status === 404) return null;
		if (!response.ok) throw new GitHubError(response.status, "GET", `branches/${branch}`, await response.text());
		const data = z
			.object({ commit: z.object({ sha: z.string(), commit: z.object({ tree: z.object({ sha: z.string() }) }) }) })
			.parse(await response.json());
		return { commit: data.commit.sha, tree: data.commit.commit.tree.sha };
	}

	/** A file's bytes at `ref`, or null when it does not exist there (or is not a file). */
	async file(repo: string, path: string, ref: string): Promise<Uint8Array | null> {
		const encoded = path.split("/").map(encodeURIComponent).join("/");
		const response = await this.call(
			"GET",
			`/repos/${this.owner}/${repo}/contents/${encoded}?ref=${ref}`,
			undefined,
			"application/vnd.github.raw+json",
		);
		if (response.status === 404) return null;
		if (!response.ok) throw new GitHubError(response.status, "GET", `contents/${path}`, await response.text());
		return new Uint8Array(await response.arrayBuffer());
	}

	/** Creates a commit on top of `parent` whose tree is `baseTree` with `entries` written as regular files. */
	async commit(repo: string, o: { parent: string; baseTree: string; entries: readonly TreeEntry[]; message: string }): Promise<string> {
		const tree = await this.json(SHA, "POST", `/repos/${this.owner}/${repo}/git/trees`, {
			base_tree: o.baseTree,
			tree: o.entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", content: e.content })),
		});
		const commit = await this.json(SHA, "POST", `/repos/${this.owner}/${repo}/git/commits`, {
			message: o.message,
			tree: tree.sha,
			parents: [o.parent],
		});
		return commit.sha;
	}

	/** Points `branch` at `sha`, creating it or force-moving it. */
	async forceBranch(repo: string, branch: string, sha: string): Promise<void> {
		const response = await this.call("PATCH", `/repos/${this.owner}/${repo}/git/refs/heads/${branch}`, { sha, force: true });
		if (response.ok) return;
		if (response.status !== 422 && response.status !== 404)
			throw new GitHubError(response.status, "PATCH", `refs/heads/${branch}`, await response.text());
		await this.json(REF, "POST", `/repos/${this.owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: sha });
	}

	/** The open pull request from `head` (a branch of the same repository) into `base`, if any. */
	async openPull(repo: string, head: string, base: string): Promise<PullRequest | null> {
		const list = await this.json(
			z.array(PULL),
			"GET",
			`/repos/${this.owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${this.owner}:${head}`)}&base=${encodeURIComponent(base)}`,
		);
		const first = list[0];
		return first === undefined ? null : { number: first.number, url: first.html_url };
	}

	async createPull(repo: string, o: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
		const pr = await this.json(PULL, "POST", `/repos/${this.owner}/${repo}/pulls`, o);
		return { number: pr.number, url: pr.html_url };
	}

	async updatePull(repo: string, number: number, o: { title?: string; body?: string; state?: "closed" }): Promise<void> {
		await this.json(PULL, "PATCH", `/repos/${this.owner}/${repo}/pulls/${number}`, o);
	}
}
