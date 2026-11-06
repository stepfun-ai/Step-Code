import { useRef } from "react";
import { useT } from "../../i18n";
import { ExtensionCreateMenu, importPluginFile, importSkillFile } from "../settings";
import type { MarketKind } from "./extension-market-data";

export function ExtensionMarketAdd({ kind }: { readonly kind: MarketKind }) {
	const t = useT();
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<ExtensionCreateMenu
				kind={kind}
				buttonClassName="extension-market-create"
				buttonId="extensionMarketNew"
				menuId="extensionMarketAddMenu"
				onUpload={() => {
					if (input.current) {
						input.current.value = "";
						input.current.click();
					}
				}}
			/>
			<input
				hidden
				type="file"
				ref={input}
				accept={kind === "plugins" ? ".zip" : ".zip,.skill,.md"}
				aria-label={t(`extensionManagement.upload.${kind}`)}
				onChange={(event) => {
					const file = event.currentTarget.files?.[0];
					event.currentTarget.value = "";
					if (kind === "plugins") {
						void importPluginFile(file, t);
						return;
					}
					void importSkillFile(file, t);
				}}
			/>
		</>
	);
}
