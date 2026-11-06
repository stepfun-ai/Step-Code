import type { ReactNode } from "react";
import { useT } from "../../i18n";
import type { ExtensionOrigin } from "../../state/types";
import { Icon } from "../../ui";
import { SettingsCard } from "./parts";

export function ExtensionSourceGroups<T>({
	items,
	origins,
	originOf,
	renderItem,
}: {
	readonly items: readonly T[];
	readonly origins: readonly ExtensionOrigin[];
	readonly originOf: (item: T) => ExtensionOrigin;
	readonly renderItem: (item: T) => ReactNode;
}) {
	const t = useT();
	return (
		<>
			{origins.map((origin) => {
				const members = items.filter((item) => {
					const value = originOf(item);
					return (origins.includes(value) ? value : "custom") === origin;
				});
				if (members.length === 0) return null;
				return (
					<section className="extension-management-group" key={origin} data-extension-origin={origin}>
						{origin === "plugin" ? (
							<details data-source-fold="plugin">
								<summary className="extension-source-heading">
									<Icon name="chevronDown" size="xs" />
									<span>{t(`extensionOrigin.${origin}`)}</span>
									<span>{members.length}</span>
								</summary>
								<SettingsCard className="settings-list extension-management-list">
									{members.map(renderItem)}
								</SettingsCard>
							</details>
						) : (
							<>
								<div className="extension-source-heading">
									<h2>{t(`extensionOrigin.${origin}`)}</h2>
									<span>{members.length}</span>
								</div>
								<SettingsCard className="settings-list extension-management-list">
									{members.map(renderItem)}
								</SettingsCard>
							</>
						)}
					</section>
				);
			})}
		</>
	);
}
