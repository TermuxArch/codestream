"use strict";
import { OktaConfigurationData } from "../protocol/agent.protocol";
import { CSOktaProviderInfo } from "../protocol/api.protocol";
import { log, lspProvider } from "../system";
import { ThirdPartyPostProviderBase } from "./provider";

@lspProvider("okta")
export class OktaProvider extends ThirdPartyPostProviderBase<CSOktaProviderInfo> {
	get displayName() {
		return "Okta";
	}

	get name() {
		return "okta";
	}

	get headers() {
		return {
			Authorization: `Bearer ${this.accessToken}`
		};
	}

	@log()
	async configure(request: OktaConfigurationData) {
		await this.session.api.setThirdPartyProviderInfo({
			providerId: this.providerConfig.id,
			data: {
				hostUrl: request.hostUrl
			}
		});
	}
}
