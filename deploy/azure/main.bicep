// Talent Radar on Azure: App Service (Linux container) + Azure Database for PostgreSQL Flexible Server + Key Vault.
// STARTING TEMPLATE — written for the IT handover and not yet deployed from this repository. Review naming,
// SKUs, networking and tagging against PlanRadar's Azure standards before use.
//
//   az group create -n rg-talent-radar -l westeurope
//   az deployment group create -g rg-talent-radar -f deploy/azure/main.bicep \
//     -p containerImage=<registry>/talent-radar:1.0.0 appName=talent-radar-prod \
//        postgresAdminPassword=<secret> bootstrapAdminEmail=<first admin> bootstrapAdminPassword=<secret>

@description('Globally unique name for the web app; also used as a prefix for other resources.')
param appName string
param location string = resourceGroup().location
@description('Full image reference, e.g. myregistry.azurecr.io/talent-radar:1.0.0')
param containerImage string
@description('Public address users will open. Defaults to the azurewebsites.net host; set to the custom domain once bound.')
param appUrl string = 'https://${appName}.azurewebsites.net'
param postgresAdminUser string = 'talentradar'
@secure()
param postgresAdminPassword string
param bootstrapAdminEmail string
param bootstrapAdminName string = 'Administrator'
@secure()
param bootstrapAdminPassword string
@description('Entra ID (OIDC) settings; leave empty to start with password sign-in and enable SSO later.')
param ssoTenantId string = ''
param ssoClientId string = ''
@secure()
param ssoClientSecret string = ''
param appServiceSku string = 'B1'
param postgresSku string = 'Standard_B1ms'

var dbName = 'talentradar'
var kvName = take('kv-${replace(appName, '-', '')}', 24)

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${appName}-plan'
  location: location
  kind: 'linux'
  sku: { name: appServiceSku }
  properties: { reserved: true }
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: '${appName}-pg'
  location: location
  sku: { name: postgresSku, tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: postgresAdminUser
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: pg
  name: dbName
}

// Simplest option: allow Azure-internal traffic. Prefer VNet integration + private endpoint if company policy requires it.
resource pgFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
  }
}

resource secretDb 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'database-url'
  properties: { value: 'postgres://${postgresAdminUser}:${uriComponent(postgresAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}' }
}
resource secretBootstrap 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'bootstrap-admin-password'
  properties: { value: bootstrapAdminPassword }
}
resource secretSso 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(ssoClientSecret)) {
  parent: kv
  name: 'sso-client-secret'
  properties: { value: ssoClientSecret }
}

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${containerImage}'
      alwaysOn: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/api/health'
      appSettings: [
        { name: 'WEBSITES_PORT', value: '8080' }
        { name: 'NODE_ENV', value: 'production' }
        { name: 'APP_URL', value: appUrl }
        { name: 'TRUST_PROXY', value: '1' }
        { name: 'DATABASE_SSL', value: 'true' }
        { name: 'DATABASE_URL', value: '@Microsoft.KeyVault(SecretUri=${secretDb.properties.secretUri})' }
        { name: 'BOOTSTRAP_ADMIN_EMAIL', value: bootstrapAdminEmail }
        { name: 'BOOTSTRAP_ADMIN_NAME', value: bootstrapAdminName }
        { name: 'BOOTSTRAP_ADMIN_PASSWORD', value: '@Microsoft.KeyVault(SecretUri=${secretBootstrap.properties.secretUri})' }
        { name: 'DEMO_DATA', value: 'false' }
        { name: 'SSO_ENABLED', value: empty(ssoClientId) ? 'false' : 'true' }
        { name: 'SSO_ISSUER', value: empty(ssoTenantId) ? '' : 'https://login.microsoftonline.com/${ssoTenantId}/v2.0' }
        { name: 'SSO_CLIENT_ID', value: ssoClientId }
        { name: 'SSO_CLIENT_SECRET', value: empty(ssoClientSecret) ? '' : '@Microsoft.KeyVault(SecretUri=${kv.properties.vaultUri}secrets/sso-client-secret)' }
      ]
    }
  }
}

// Lets the web app read its secrets from Key Vault (role: Key Vault Secrets User).
resource kvAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, app.id, 'kv-secrets-user')
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

output appHostname string = app.properties.defaultHostName
output ssoRedirectUri string = '${appUrl}/api/auth/sso/callback'
output postgresHost string = pg.properties.fullyQualifiedDomainName
