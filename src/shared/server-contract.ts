export const SERVER_PROTOCOL_VERSION = 1 as const

export const SERVER_PROTOCOL_DIGEST = "f29a63daeb291c66badcc5b3eaf4a61ee7f268176f4d03d78a9d4194134b445c" as const

export const SERVER_HTTP_ROUTES = [
  {
    "method": "DELETE",
    "path": "/ai/agent-profiles/{profile_id}",
    "schemaDigest": "71f63a2a7ef3ba772841b3b7709134eaff0df2781fedfe800c867dca833af6b1"
  },
  {
    "method": "DELETE",
    "path": "/ai/chat/threads/{thread_id}",
    "schemaDigest": "7f9d4a2aed4b21a61af43a3b576d57ac583abe73b69e7f73bfbf0fcb217454a1"
  },
  {
    "method": "DELETE",
    "path": "/ai/memories",
    "schemaDigest": "5e06bc701f563ce55d560a42c8fd7e779a64463399bc2e0a5c2b6f966957f41c"
  },
  {
    "method": "DELETE",
    "path": "/ai/providers/{provider_id}",
    "schemaDigest": "1dcacd10e5327807fb4eb8c6ce8622bc6c895e8d40e95461d7948457dc7b91ac"
  },
  {
    "method": "DELETE",
    "path": "/ai/reports/{report_id}",
    "schemaDigest": "b3ee4b2782b5c27810d6e4f43a179c225a993c28204f73d980840f303dec5bc2"
  },
  {
    "method": "DELETE",
    "path": "/categories/{category_id}",
    "schemaDigest": "f1d75fbd013aa50b0811ff28dc0cc43cee9315c46142004882f4e113abacdc1e"
  },
  {
    "method": "DELETE",
    "path": "/documents/{document_id}",
    "schemaDigest": "c7c7f844bbc44bda9f19998c7e4f55ff9a8cb9e37177489f6ea79782a8d69a28"
  },
  {
    "method": "DELETE",
    "path": "/watch/{watch_id}",
    "schemaDigest": "233419b1dc2b61f268b3053db842c6ec3bc4d6a551f98b5f6517def935aae996"
  },
  {
    "method": "DELETE",
    "path": "/workspaces/{workspace_id}",
    "schemaDigest": "4d7e73ff175643811c54bcd6cac5a0006513c170102f00fb359f753821d968c9"
  },
  {
    "method": "DELETE",
    "path": "/workspaces/{workspace_id}/assets/{asset_id}",
    "schemaDigest": "f7a9ec5195e68c6225968769c020bc5203ef0369975601525292842b168fd25a"
  },
  {
    "method": "DELETE",
    "path": "/workspaces/{workspace_id}/connections/{connection_id}",
    "schemaDigest": "30dadf582669f6c6d1707b063ea12fc59e40f1692c714a29f5211345250ba891"
  },
  {
    "method": "DELETE",
    "path": "/workspaces/{workspace_id}/items/{item_id}",
    "schemaDigest": "d350f2cea71bc41844c7740d001a4ea2037330d4532638281f246398d64eec89"
  },
  {
    "method": "DELETE",
    "path": "/workspaces/{workspace_id}/notes/{note_id}",
    "schemaDigest": "59a8fb2969b2a9de12c12de9d1b849f2a5656cc0e00bab6cd549a8674396e98b"
  },
  {
    "method": "GET",
    "path": "/ai/agent-profiles",
    "schemaDigest": "74306f82557879f3c3322b91445412f6cc11f16eee0f4e587183e2d007865522"
  },
  {
    "method": "GET",
    "path": "/ai/chat/runs/{run_id}",
    "schemaDigest": "5cb7abb52fce630cc833956b6f640350b3ae62147e6be89a3321fb900809577e"
  },
  {
    "method": "GET",
    "path": "/ai/chat/runs/{run_id}/pending-interrupt",
    "schemaDigest": "d74acf8315422c586800db341ae4ea271bc8d45b1491613d4424fe921d1f9cee"
  },
  {
    "method": "GET",
    "path": "/ai/chat/threads",
    "schemaDigest": "cefb157e0e5acb6468ee54cc470ed2db337d19cfa4fb0d292371e8a8bb52bd4e"
  },
  {
    "method": "GET",
    "path": "/ai/chat/threads/{thread_id}/history",
    "schemaDigest": "2a7007f68591d6ed6252add731e406d563773020eb0a19f0012c6d0f2b76346f"
  },
  {
    "method": "GET",
    "path": "/ai/chat/threads/{thread_id}/traces",
    "schemaDigest": "77eb6b14f336ef02a19a1d94ac1db48b6ff14d11749c23f90a36122fd65726a9"
  },
  {
    "method": "GET",
    "path": "/ai/cli-runtimes",
    "schemaDigest": "7be55ebc3a5c79f4b91c657aa141cfc17338b02aa3ea06cf16429ea9d77a36bc"
  },
  {
    "method": "GET",
    "path": "/ai/doc-text/{document_id}",
    "schemaDigest": "18760c40e3b065c87e0737f736746519db477a0c41f6d59e1e5ffbe8eeaea210"
  },
  {
    "method": "GET",
    "path": "/ai/memories",
    "schemaDigest": "7bff5aa4068301a9d52cd31cebcf97102e4023a4c5e94bb264b32c20e7c9be83"
  },
  {
    "method": "GET",
    "path": "/ai/providers",
    "schemaDigest": "5896e82b4d897e38836eb8ebe45aea368622bf785b7f158f9d4b00b5b210650e"
  },
  {
    "method": "GET",
    "path": "/ai/reports",
    "schemaDigest": "87a109b2e86bc0c69b6064659b26cfd9674dfe34370f105a91cc86356939940a"
  },
  {
    "method": "GET",
    "path": "/ai/summary/{document_id}",
    "schemaDigest": "3e84157a967d12e0554bb928b294c90c83762d854650a13cc9d70ff118e6e59b"
  },
  {
    "method": "GET",
    "path": "/ai/usage",
    "schemaDigest": "171ff6be52afbb248c161a0cb02343b168dbc91392b791f5dbf28bd52909b58e"
  },
  {
    "method": "GET",
    "path": "/app/bootstrap",
    "schemaDigest": "e8fb648a7d16c293a7665206801ea74cde873e8ba8ba9fa5a3fbe4677d1d1800"
  },
  {
    "method": "GET",
    "path": "/categories",
    "schemaDigest": "ecd90208edcf9cf87dc42e782011ceafdef511e28dbffaffa58a233d3be507b0"
  },
  {
    "method": "GET",
    "path": "/documents",
    "schemaDigest": "90a2d58d5ca90b12d40f67a3cb108c4cf2cfcc5330dfe724f5f319bb57b66743"
  },
  {
    "method": "GET",
    "path": "/documents/count",
    "schemaDigest": "b5f31c5c82d840ece1e41ddc991f5c94d125932cecc3070b91ceff4dcf77fabb"
  },
  {
    "method": "GET",
    "path": "/documents/search",
    "schemaDigest": "90bec279a35eb2013049776a5004b2d3e1ba5e925a5129941f35e9666082bf20"
  },
  {
    "method": "GET",
    "path": "/documents/{document_id}",
    "schemaDigest": "4a9db24c63382e369fa0c66b5d75462f1ace631d1947cd71b4fa01b4946097af"
  },
  {
    "method": "GET",
    "path": "/documents/{document_id}/pdf-annotations",
    "schemaDigest": "e7a5eb24ded32cdbaf06b98bc657d5aea7b9bd198db33b546b96fb3474e5228a"
  },
  {
    "method": "GET",
    "path": "/export/bibtex-string",
    "schemaDigest": "e12bbfc4e8c34e5b62ed0e26da309a14ad7bbb3b3c61027db63befb9381d71b4"
  },
  {
    "method": "GET",
    "path": "/health",
    "schemaDigest": "fde7e52a1e0de04bced26c09fe5c59b799f848593ca29bc667d721e768a8204f"
  },
  {
    "method": "GET",
    "path": "/mineru/status",
    "schemaDigest": "fcb00c98779cd340a2fa664147a2e1e19778b2e47933062720e2f32ca7c36166"
  },
  {
    "method": "GET",
    "path": "/ocr/documents/{document_id}/results/{result_key}/assets/{asset_path:path}",
    "schemaDigest": "59ee9a577de8302f4062f86732a0249fc8289b59dc20869fe0fdd08a4a7a4e24"
  },
  {
    "method": "GET",
    "path": "/ocr/documents/{document_id}/results/{result_key}/markdown",
    "schemaDigest": "2e502b8fd6e15a0bfe941c58e56ddfb572842162d2d76b7e25805ea845f4d782"
  },
  {
    "method": "GET",
    "path": "/ocr/state",
    "schemaDigest": "2098bf694380c0d286179710f857bd2c885bc758b1d3712dc3e84af7e3caf402"
  },
  {
    "method": "GET",
    "path": "/ready",
    "schemaDigest": "24f2bdb9cde10420cbb2eabc5ba4dcfe576bf66859895c48acc4940171b064db"
  },
  {
    "method": "GET",
    "path": "/search/global",
    "schemaDigest": "f49dd0a1219e83f5eab40f1ee9e0976c25da3e654ed349109c01c439e779b545"
  },
  {
    "method": "GET",
    "path": "/settings",
    "schemaDigest": "f00b6cca24f9e73db8525c3bca03deaacf65004e97dbc82620c58b181cc9bd09"
  },
  {
    "method": "GET",
    "path": "/settings/web-search",
    "schemaDigest": "d223e3f95d0443b86105d5f0eeb8fbf5eb5f89f93b2b903ab5cc364a0486baec"
  },
  {
    "method": "GET",
    "path": "/watch",
    "schemaDigest": "c6dd6673fd15bcd67f0026980fdf162be074c0d0ed5a23d7272db81091a96f5c"
  },
  {
    "method": "GET",
    "path": "/workspace-assets/{asset_id}",
    "schemaDigest": "daa6b9adbf6f18ad3269d664ee0ff570dce160509efc21d518f7447b4044f52b"
  },
  {
    "method": "GET",
    "path": "/workspace-assets/{asset_id}/content",
    "schemaDigest": "ca55af78a79d2e6c6dee48d44c0fbabcecf7c4d5ecd49fbcc9f61b8e06ce4f0c"
  },
  {
    "method": "GET",
    "path": "/workspace-connections/{connection_id}",
    "schemaDigest": "5c47796b010982e74967fb205e85c153ccf33c5f43aa4aeb7cf3aa60d7bbcaca"
  },
  {
    "method": "GET",
    "path": "/workspace-items/{item_id}",
    "schemaDigest": "67edea564399ff8d221f9e4d7c5b56ee0589ef961e59d24ace582fbdce0beda1"
  },
  {
    "method": "GET",
    "path": "/workspace-notes/{note_id}",
    "schemaDigest": "7f9969300f36bfee113a1126cced4b5ddf116ddb66d586dac2819f009cbb380e"
  },
  {
    "method": "GET",
    "path": "/workspaces",
    "schemaDigest": "cef9840be6b0cdd4ab7a39195102f6fa32d7fc7bbd5fbab10716e510c72d0ecb"
  },
  {
    "method": "GET",
    "path": "/workspaces/{workspace_id}/assets",
    "schemaDigest": "39f1bbb4b781f1bab4d99565a585a3cdb15f25a4b90eeef48a2d3cc540d8bf38"
  },
  {
    "method": "GET",
    "path": "/workspaces/{workspace_id}/assets/{asset_id}/preview",
    "schemaDigest": "037988bbec8cfc4768e5f88b5fa1c582f8a1a955cbf6b063ab0f708b45c4ebd9"
  },
  {
    "method": "GET",
    "path": "/workspaces/{workspace_id}/canvas",
    "schemaDigest": "b9fbf3c383a9bc79e9a0a201b191898afd0db7b7cb68152c3301778dc1ddfd9e"
  },
  {
    "method": "GET",
    "path": "/workspaces/{workspace_id}/connections",
    "schemaDigest": "9d411c0cd0adddcfd8463beb792cb3122ba6d6ecb2b1707752199c11c4661a10"
  },
  {
    "method": "GET",
    "path": "/workspaces/{workspace_id}/items",
    "schemaDigest": "795eb20cdeb94b493618f7ba5812f5360464b46ff4998cf069b389deae7e6ad2"
  },
  {
    "method": "GET",
    "path": "/workspaces/{workspace_id}/notes",
    "schemaDigest": "b57adcc8eb5b0dfc8a890ceececa13869e18ff83f14a3c62fbeed8a965f7ae43"
  },
  {
    "method": "PATCH",
    "path": "/ai/agent-profiles/{profile_id}",
    "schemaDigest": "178da1c39cca096e07d778ed8211e87f7bbd2fc891b599343cb3d03194a6a4ad"
  },
  {
    "method": "PATCH",
    "path": "/ai/chat/threads/{thread_id}",
    "schemaDigest": "b77c971a4435708c314087e22167b34aa1e77aa3f2649ce83c3e8f5d0f49d39a"
  },
  {
    "method": "PATCH",
    "path": "/ai/providers/{provider_id}",
    "schemaDigest": "d31a8464fc1a2096074252c2ec3291f040ce9e8ded20cf620b76329e6d5b8e5b"
  },
  {
    "method": "PATCH",
    "path": "/ai/reports/{report_id}",
    "schemaDigest": "0a5396bbb7d48a3e6b87e86f4b297db651fc0d0b38306b6204ed73ce82d5e015"
  },
  {
    "method": "PATCH",
    "path": "/categories/{category_id}",
    "schemaDigest": "2dc1099dcaa9aed4fdafd21b7657bc4f4e42cdcfb308fc250125f0c9eb5d9d5c"
  },
  {
    "method": "PATCH",
    "path": "/documents/{document_id}",
    "schemaDigest": "618267cf1152867fc846bc462d29984e68b47978dfc325a3a92f451d512d9d32"
  },
  {
    "method": "PATCH",
    "path": "/settings",
    "schemaDigest": "274afa5d831b48a606e0bb4e3d2dfc1a920604ff858098a1fe7af7c8bfe8b1cc"
  },
  {
    "method": "PATCH",
    "path": "/settings/web-search",
    "schemaDigest": "06a7b9c6bb33c97aa546ff76ff2e24f1beae8cfafc1e118f19671a745862cee6"
  },
  {
    "method": "PATCH",
    "path": "/workspaces/{workspace_id}",
    "schemaDigest": "33a9a4bdf1a9d5ca026a02781468094f428f17807834f1a2baa34641cfcee734"
  },
  {
    "method": "PATCH",
    "path": "/workspaces/{workspace_id}/items/{item_id}/size",
    "schemaDigest": "cb73ef8932322048a8267b4566c7c3976a59f17595f27e7eecb6302abecadc89"
  },
  {
    "method": "PATCH",
    "path": "/workspaces/{workspace_id}/notes/{note_id}",
    "schemaDigest": "1e1eb648ddcf432c9aed52825525cba0210bf346490a47340208da3aa46af72e"
  },
  {
    "method": "POST",
    "path": "/ai/agent-profiles",
    "schemaDigest": "3a702a3a87fea16c5db79952af2dcdd620c6f534a2ef0041fedf26510a13ee6f"
  },
  {
    "method": "POST",
    "path": "/ai/agent-profiles/{profile_id}/models",
    "schemaDigest": "27e4773d602fe6792f31035aafcad2799a7306016d1f68fc1608993b86d94422"
  },
  {
    "method": "POST",
    "path": "/ai/agent-profiles/{profile_id}/test",
    "schemaDigest": "e974d823ef780ef691c369647ac1981dc1c6451b2f50e067cfc16552492fae27"
  },
  {
    "method": "POST",
    "path": "/ai/chat/cancel",
    "schemaDigest": "2429cf6c6ca951a91a2b5392f08587237cc7c76caf2c05f62758d2cd3f9bfc52"
  },
  {
    "method": "POST",
    "path": "/ai/chat/resume",
    "schemaDigest": "0534c3effad137a20af77db8c2c3cbadbc8aa424df32395508206f526d8ad4eb"
  },
  {
    "method": "POST",
    "path": "/ai/chat/send",
    "schemaDigest": "e714dc7be612a86f7b5098c133f97dcd4f20ba95cce1ecb9451803a67af7dc8c"
  },
  {
    "method": "POST",
    "path": "/ai/cli-tools/{run_id}/call",
    "schemaDigest": "8eb9c7155811b826dd06de2a9ce7469fddf32b8c2832e4b2852b821203edf6fa"
  },
  {
    "method": "POST",
    "path": "/ai/cli-tools/{run_id}/list",
    "schemaDigest": "f0cc87c810e807429a55e12105f2676c33b935adfe88047612a9a79e1e9ace75"
  },
  {
    "method": "POST",
    "path": "/ai/providers",
    "schemaDigest": "a8fb96d968f5f70e27331d4d21be278094c6d8167355ea2aa8cfb535038e071b"
  },
  {
    "method": "POST",
    "path": "/ai/providers/models",
    "schemaDigest": "f29c29d79e7309cc10afc4d2d5737f0e1201b31ad6015925a041f8a6a82730be"
  },
  {
    "method": "POST",
    "path": "/ai/providers/{provider_id}/test",
    "schemaDigest": "8c632f8457d217f14be11630f3014efa18fa9c06eadebe710954d5bd08b3f4ca"
  },
  {
    "method": "POST",
    "path": "/ai/summarize",
    "schemaDigest": "21ef459c725187f061caec6805da717bde2ab598c239dc46f39778822dc7018c"
  },
  {
    "method": "POST",
    "path": "/categories",
    "schemaDigest": "36c6d2f6fa516b41f10f90b287e850b6e944db24fd2ffb13ecd3899cf7708f6f"
  },
  {
    "method": "POST",
    "path": "/categories/{category_id}/assign",
    "schemaDigest": "ca06f5eb71f24b64a5ec669a8605a6f8e4e1240f3b3423dccafe6ebc843ea6b6"
  },
  {
    "method": "POST",
    "path": "/categories/{category_id}/unassign",
    "schemaDigest": "fbef09dfd73edf663cb8c5efbfa5faf67596cac6ea2f4c23f2091a14665e2b4f"
  },
  {
    "method": "POST",
    "path": "/clipboard/copy-markdown",
    "schemaDigest": "eaac9a24dd35b5bf22661b0ac1e6f3d0bb728d5805ad7be4b609ecf012d4e303"
  },
  {
    "method": "POST",
    "path": "/clipboard/copy-workspace-asset",
    "schemaDigest": "eaac9a24dd35b5bf22661b0ac1e6f3d0bb728d5805ad7be4b609ecf012d4e303"
  },
  {
    "method": "POST",
    "path": "/clipboard/write-text",
    "schemaDigest": "324b35f670f32abae0b5ca133d8bfcede36a96dea0eefa18f04ededf04998c93"
  },
  {
    "method": "POST",
    "path": "/documents/bulk-categorize",
    "schemaDigest": "b67f67d60658b30673fc97cdba2b87c4f3b1128b75a7ea4fc1e11cf96a3e15f0"
  },
  {
    "method": "POST",
    "path": "/documents/bulk-delete",
    "schemaDigest": "a82911ffd48506c6971a1bc60edd52b1021be6e92ee8202afeb6f3b123a4a468"
  },
  {
    "method": "POST",
    "path": "/documents/bulk-refresh-metadata",
    "schemaDigest": "b67f67d60658b30673fc97cdba2b87c4f3b1128b75a7ea4fc1e11cf96a3e15f0"
  },
  {
    "method": "POST",
    "path": "/documents/{document_id}/open-in-finder",
    "schemaDigest": "ae88a61bd6c7b852627e6bdf28b44f913bcbdfe6b83fe50bc4b83c084d0decef"
  },
  {
    "method": "POST",
    "path": "/documents/{document_id}/open-pdf",
    "schemaDigest": "ed2fe5a9408e32af55a9d309e8c5fba49d5a0ab8086cec3bee9316ad6d89654f"
  },
  {
    "method": "POST",
    "path": "/documents/{document_id}/refresh-metadata",
    "schemaDigest": "47f05eede3cf85aa5800408f8f021acce6dd8b1eb172092320316ecedf5b0e80"
  },
  {
    "method": "POST",
    "path": "/documents/{document_id}/relocate",
    "schemaDigest": "90fff0ae7c9f61b5d53d487b85f36b949c730acffc97318833980a83aa418b62"
  },
  {
    "method": "POST",
    "path": "/documents/{document_id}/restore-file",
    "schemaDigest": "cd3c0cc0c123ddc10fec198a80463dab90fb593171cc778545fe0f8bd79977e1"
  },
  {
    "method": "POST",
    "path": "/documents/{document_id}/starred",
    "schemaDigest": "048be4ba907325f6b6a9a2cad76451e90101d58507f17117905f0704eaef274c"
  },
  {
    "method": "POST",
    "path": "/export/bibtex",
    "schemaDigest": "e310399a5c157f8510ff02dc4e9d73f8fcb13842a9983b2b03d65ce334f39648"
  },
  {
    "method": "POST",
    "path": "/export/json",
    "schemaDigest": "6644aa92275622bb385658d9f452f502ecdbbf90172aa94393dc3456bddf1f55"
  },
  {
    "method": "POST",
    "path": "/import/files",
    "schemaDigest": "f4e8f25e088f491f0dba876c8600c71bde017c6d0f3d408dc01e880977811b9f"
  },
  {
    "method": "POST",
    "path": "/import/folder",
    "schemaDigest": "3fa9bab3d0ac68d202263cae5afd8da3819cdfe8b7c20ed535c8385d9853b333"
  },
  {
    "method": "POST",
    "path": "/import/identifier",
    "schemaDigest": "7921221c9aa824ac00a18c71ea1bab04796384417c7b06213ffe371918e4a90a"
  },
  {
    "method": "POST",
    "path": "/import/json",
    "schemaDigest": "fc21d8ca696e01322892ceff1923fd36e1aa6f854765a8350261fbccde08d3ef"
  },
  {
    "method": "POST",
    "path": "/import/mendeley",
    "schemaDigest": "16b2986e1fb2cf5c57fca3d809574213d4727d2ca4b8d2a612bc28c176067688"
  },
  {
    "method": "POST",
    "path": "/import/zotero",
    "schemaDigest": "b85e76ddd5eb8c2d61b90519685fb3e5e3f84264608264d8021b7001f2e6588a"
  },
  {
    "method": "POST",
    "path": "/mineru/cancel-install",
    "schemaDigest": "17653d8716a24a3d583a40a2ebb38e9530da7448a8453cda6663834d67a514b0"
  },
  {
    "method": "POST",
    "path": "/mineru/choose-install-root",
    "schemaDigest": "3e8ab05d411d2c916a8d50f721f9652820373c3858b273f721b8eb1d145a514d"
  },
  {
    "method": "POST",
    "path": "/mineru/install",
    "schemaDigest": "780c33a9f3013ed7043a5b498db5557d87a7dddf6a7b13e4880a11c6bbc58da3"
  },
  {
    "method": "POST",
    "path": "/mineru/uninstall",
    "schemaDigest": "17653d8716a24a3d583a40a2ebb38e9530da7448a8453cda6663834d67a514b0"
  },
  {
    "method": "POST",
    "path": "/ocr/cancel",
    "schemaDigest": "55ab70beca893e8d3218fb080ac9441a0157aa5453090eea5f810ab26010624d"
  },
  {
    "method": "POST",
    "path": "/ocr/start",
    "schemaDigest": "27187a8b0784f65ab62ab8d498765da0e945f6cbff84148a5dc749b9144e7c92"
  },
  {
    "method": "POST",
    "path": "/settings/web-search/test",
    "schemaDigest": "35bc3149469f0e8b814a35d491254ca8c1e19e0d4834f5245af001b750b37ece"
  },
  {
    "method": "POST",
    "path": "/watch",
    "schemaDigest": "43357bc20b7a987043c16a18b50087fb02ddbe0b8b1f914389574625c4af2834"
  },
  {
    "method": "POST",
    "path": "/watch/{watch_id}/toggle",
    "schemaDigest": "8c3418780a14df9d26f462293b22e3797ea4079ad13f2efde163985d6edad7ae"
  },
  {
    "method": "POST",
    "path": "/workspaces",
    "schemaDigest": "a7648eab84f0f03364631fa82a1bc8770a2edf4cc5f757d6ecccec7d759b7556"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/assets/files",
    "schemaDigest": "8433e9e94410854ec6b5266a3112c4ef8ee1c143f2319391a37fbd9bdbcce8d2"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/assets/{asset_id}/open",
    "schemaDigest": "f7a9ec5195e68c6225968769c020bc5203ef0369975601525292842b168fd25a"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/assets/{asset_id}/reveal",
    "schemaDigest": "f7a9ec5195e68c6225968769c020bc5203ef0369975601525292842b168fd25a"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/connections",
    "schemaDigest": "09af6cee3830ba7aa5749441eddc120e52e974be49c4fa47a2b1bb14120cd445"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/files",
    "schemaDigest": "0b9e322da7102edd67f13725f3494ef792d2a52659374e1220cbc2a480af88a7"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/items/batch",
    "schemaDigest": "c073234e8581d140bd9758ec86dbf71688ccc46043478e65624df2addfc35842"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/items/move",
    "schemaDigest": "4293bfe7db1b0cecf2d62a4b1ae1ad312ab22beb58d2be0541efccbc44d38366"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/items/reorder",
    "schemaDigest": "e1242a9c479f0d10585ad077407f6ad3b7f4d4f343a913afa1276471746644df"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/notes",
    "schemaDigest": "7e8cac7459ab553e5e6fa2fccfac146d6b0351f3458eee794dc052fbae24aef6"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/open-sandbox",
    "schemaDigest": "4d7e73ff175643811c54bcd6cac5a0006513c170102f00fb359f753821d968c9"
  },
  {
    "method": "PUT",
    "path": "/ai/memories",
    "schemaDigest": "29f943a433d4aa339a86b4a9e90a1b22f46ed7f94664d46902c0d2cf8a419bd9"
  },
  {
    "method": "PUT",
    "path": "/documents/{document_id}/pdf-annotations",
    "schemaDigest": "7bff991c85cda049761db0fee36a8db053bbea5719c4caf37ee8e4dfccda3a72"
  },
  {
    "method": "PUT",
    "path": "/workspaces/{workspace_id}/canvas",
    "schemaDigest": "c45c598bbf7a0e26e28a8757e8e23e97cffed4ea7167d69f39c66529d8b2ffc1"
  }
] as const

export const SERVER_WEBSOCKET_PATH = "/ws" as const

export const SERVER_EVENT_NAMES = [
  "ai.chat.token",
  "ai.chat.reasoning",
  "ai.chat.done",
  "ai.chat.error",
  "ai.chat.trace",
  "ai.chat.interrupted",
  "ai.chat.run-status",
  "ai.chat.title-updated",
  "ai.summary.updated",
  "ai.summary.error",
  "ai.report.created",
  "document.updated",
  "import.progress",
  "import.toast",
  "workspace.items.changed",
  "mineru.install-progress",
  "ocr.progress",
  "ocr.completed",
  "ocr.error"
] as const

export const CONNECTOR_EVENT_NAMES = [
  "connector.trash-item",
  "connector.open-path",
  "connector.show-in-folder",
  "connector.dialog-open-directory",
  "connector.dialog-open-file",
  "connector.dialog-choose",
  "connector.clipboard-write",
  "connector.clipboard-write-file",
  "connector.encrypt-api-key",
  "connector.decrypt-api-key",
  "connector.apply-proxy"
] as const

export const CLIENT_WEBSOCKET_EVENT_NAMES = [
  "subscribe",
  "unsubscribe",
  "ping",
  "connector.result",
  "connector.error"
] as const

export const SERVER_WEBSOCKET_EVENT_NAMES = [
  "subscribed",
  "unsubscribed",
  "pong"
] as const

export type ServerEventName = (typeof SERVER_EVENT_NAMES)[number]

export type ConnectorEventName = (typeof CONNECTOR_EVENT_NAMES)[number]

export type ServerWebsocketEventName = (typeof SERVER_WEBSOCKET_EVENT_NAMES)[number]

