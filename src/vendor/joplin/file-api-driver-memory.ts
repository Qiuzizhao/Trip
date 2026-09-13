// Vendored from Joplin (laurent22/joplin @ 141c451ff938e96fd0d21dab027147e59e0bf0e3, 2026-09-12)
// 原路径：packages/lib/file-api-driver-memory.ts（232 行）
// 本地改动：fs-extra 的两处调用改为 shim.fsDriver()；其余保持上游一致。
// 用途：仅作为 FileApi 的单测替身（Node/jest 环境，依赖全局 Buffer）。
// @ts-nocheck
import time from './time';
import shim from './shim';
import { basicDelta, DeltaOptions, GetOptions, MultiPutItem, PutOptions } from './file-api';

interface MemoryItem {
	path: string;
	isDir: boolean;
	updated_time: number;
	content: string;
	isDeleted?: boolean;
}

export default class FileApiDriverMemory {

	private items_: MemoryItem[];
	private deletedItems_: MemoryItem[];

	public constructor() {
		this.items_ = [];
		this.deletedItems_ = [];
	}

	private encodeContent_(content: string | Buffer) {
		if (content instanceof Buffer) {
			return content.toString('base64');
		} else {
			return Buffer.from(content).toString('base64');
		}
	}

	public get supportsMultiPut() {
		return true;
	}

	public get supportsMultiDelete() {
		return true;
	}

	public get supportsAccurateTimestamp() {
		return true;
	}

	private decodeContent_(content: string) {
		if (!content) return '';
		return Buffer.from(content, 'base64').toString('utf-8');
	}

	public itemIndexByPath(path: string) {
		for (let i = 0; i < this.items_.length; i++) {
			if (this.items_[i].path === path) return i;
		}
		return -1;
	}

	public itemByPath(path: string) {
		const index = this.itemIndexByPath(path);
		return index < 0 ? null : this.items_[index];
	}

	public newItem(path: string, isDir = false) {
		const now = time.unixMs();
		return {
			path: path,
			isDir: isDir,
			updated_time: now, // In milliseconds!!
			// created_time: now, // In milliseconds!!
			content: '',
		};
	}

	public stat(path: string) {
		const item = this.itemByPath(path);
		return Promise.resolve(item ? { ...item } : null);
	}

	public async setTimestamp(path: string, timestampMs: number): Promise<void> {
		const item = this.itemByPath(path);
		if (!item) return Promise.reject(new Error(`File not found: ${path}`));
		item.updated_time = timestampMs;
	}

	public async list(path: string) {
		const output = [];

		for (let i = 0; i < this.items_.length; i++) {
			const item = this.items_[i];
			if (item.path === path) continue;
			if (item.path.indexOf(`${path}/`) === 0) {
				const s = item.path.substr(path.length + 1);
				if (s.split('/').length === 1) {
					const it = { ...item };
					it.path = it.path.substr(path.length + 1);
					output.push(it);
				}
			}
		}

		return Promise.resolve({
			items: output,
			hasMore: false,
			context: null,
		});
	}

	public async get(path: string, options: GetOptions) {
		const item = this.itemByPath(path);
		if (!item) return Promise.resolve(null);
		if (item.isDir) return Promise.reject(new Error(`${path} is a directory, not a file`));

		let output = null;
		if (options.target === 'file') {
			await shim.fsDriver().writeFileBase64(options.path, item.content);
		} else {
			const content = this.decodeContent_(item.content);
			output = Promise.resolve(content);
		}

		return output;
	}

	public async mkdir(path: string) {
		const index = this.itemIndexByPath(path);
		if (index >= 0) return;
		this.items_.push(this.newItem(path, true));
	}

	public async put(path: string, content: string | Buffer, options: PutOptions = null) {
		if (!options) options = {};

		if (options.source === 'file') content = await shim.fsDriver().readFile(options.path, 'base64');

		const index = this.itemIndexByPath(path);
		if (index < 0) {
			const item = this.newItem(path, false);
			item.content = this.encodeContent_(content);
			this.items_.push(item);
			return item;
		} else {
			this.items_[index].content = this.encodeContent_(content);
			this.items_[index].updated_time = time.unixMs();
			return this.items_[index];
		}
	}

	public async multiPut(items: MultiPutItem[], options: PutOptions = null) {
		const output: { items: Record<string, { item: MemoryItem | null; error: Error | null }> } = {
			items: {},
		};

		for (const item of items) {
			try {
				const processedItem = await this.put(`/root/${item.name}`, item.body, options);
				output.items[item.name] = {
					item: processedItem,
					error: null,
				};
			} catch (error) {
				output.items[item.name] = {
					item: null,
					error: error,
				};
			}
		}

		return output;
	}

	public async multiDelete(itemNames: string[]) {
		type ItemOutput = {
			[id: string]: { error?: Error };
		};
		const output = {
			items: Object.create(null) as ItemOutput,
		};

		for (const name of itemNames) {
			try {
				await this.delete(`/root/${name}`);
				output.items[name] = {
					error: null,
				};
			} catch (error) {
				output.items[name] = {
					error: error,
				};
			}
		}

		return output;
	}

	public async delete(path: string) {
		const index = this.itemIndexByPath(path);
		if (index >= 0) {
			const item = { ...this.items_[index] };
			item.isDeleted = true;
			item.updated_time = time.unixMs();
			this.deletedItems_.push(item);
			this.items_.splice(index, 1);
		}
	}

	public async move(oldPath: string, newPath: string): Promise<void> {
		const sourceItem = this.itemByPath(oldPath);
		if (!sourceItem) return Promise.reject(new Error(`Path not found: ${oldPath}`));
		await this.delete(newPath); // Overwrite if newPath already exists
		sourceItem.path = newPath;
	}

	public async format() {
		this.items_ = [];
	}

	public async delta(path: string, options: DeltaOptions = null) {
		const getStatFn = async (path: string) => {
			const output = this.items_.slice();
			for (let i = 0; i < output.length; i++) {
				const item = { ...output[i] };
				item.path = item.path.substr(path.length + 1);
				output[i] = item;
			}
			return output;
		};

		const output = await basicDelta(path, getStatFn, options);
		return output;
	}

	public async clearRoot() {
		this.items_ = [];
	}
}
