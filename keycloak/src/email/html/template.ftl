<#--
  This file has been claimed for ownership from @keycloakify/email-native version 260007.0.0.
  To relinquish ownership and restore this file to its original content, run the following command:

  $ npx keycloakify own --path "email/html/template.ftl" --revert
-->
<#--
  groundplan carbon email wrapper. Emails are server-rendered HTML with no
  JS/Tailwind, so this is plain, table-based, inline-styled markup using the
  carbon palette as literal hex values (email clients strip CSS variables and web
  fonts). Every HTML email (password reset, verify email, executeActions, …)
  renders its body inside the card below via `<#nested>`.
-->

<#macro emailLayout>
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
    <meta name="color-scheme" content="dark"/>
    <meta name="supported-color-schemes" content="dark"/>
    <title>groundplan</title>
    <style>
        /* Best-effort (clients that honour <style>): link colour + paragraph
           spacing. The inline styles below carry the rest for clients that
           strip embedded CSS. */
        body { margin: 0; padding: 0; width: 100% !important; }
        a { color: #4c8dff; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .gp-body p { margin: 0 0 14px 0; }
        .gp-body p:last-child { margin-bottom: 0; }
    </style>
</head>
<body style="margin:0; padding:0; background-color:#0c0d10; color:#e8eaed; -webkit-font-smoothing:antialiased; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0c0d10;">
        <tr>
            <td align="center" style="padding:32px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px; width:100%;">
                    <!-- wordmark -->
                    <tr>
                        <td style="padding:0 4px 18px 4px;">
                            <span style="font-size:20px; font-weight:700; letter-spacing:-0.5px; color:#e8eaed;">groundplan</span>
                        </td>
                    </tr>
                    <!-- card -->
                    <tr>
                        <td class="gp-body" style="background-color:#17191f; border:1px solid #23262d; border-radius:8px; padding:28px; font-size:15px; line-height:1.6; color:#e8eaed;">
                            <#nested>
                        </td>
                    </tr>
                    <!-- footer -->
                    <tr>
                        <td style="padding:18px 4px 0 4px; font-size:12px; line-height:1.5; color:#6b7079;">
                            Secured by Keycloak &middot; groundplan
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
</#macro>
