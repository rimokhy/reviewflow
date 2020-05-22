import type { Router } from 'express';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GitHubAPI } from 'probot/lib/github';
import { syncUser } from '../account-handlers/actions/syncUser';
import type { MongoStores } from '../mongo';
import Layout from '../views/Layout';
import { getUser } from './auth';

export default function userSettings(
  router: Router,
  api: GitHubAPI,
  mongoStores: MongoStores,
): void {
  router.get('/user/force-sync', async (req, res) => {
    const user = await getUser(req, res);
    if (!user) return;

    // const { data: installation } = await api.apps
    //   .getUserInstallation({
    //     username: user.authInfo.login,
    //   })
    //   .catch((err) => {
    //     return { status: err.status, data: undefined };
    //   });

    // console.log(installation);

    const u = await mongoStores.users.findByKey(user.authInfo.id);
    if (!u || !u.installationId) return res.redirect('/app');

    await syncUser(
      mongoStores,
      user.api,
      u.installationId as number,
      user.authInfo,
    );

    res.redirect(`/app/user`);
  });

  router.get('/user', async (req, res) => {
    const user = await getUser(req, res);
    if (!user) return;

    const { data: installation } = await api.apps
      .getUserInstallation({
        username: user.authInfo.login,
      })
      .catch((err) => {
        return { status: err.status, data: undefined };
      });

    if (!installation) {
      return res.send(
        renderToStaticMarkup(
          <Layout>
            <div>
              {process.env.REVIEWFLOW_NAME}{' '}
              {"isn't installed for this user. Go to "}
              <a
                href={`https://github.com/settings/apps/${process.env.REVIEWFLOW_NAME}/installations/new`}
              >
                Github Configuration
              </a>{' '}
              to install it.
            </div>
          </Layout>,
        ),
      );
    }

    return res.send(
      renderToStaticMarkup(
        <Layout>
          <div>{process.env.REVIEWFLOW_NAME} is installed for this user</div>
        </Layout>,
      ),
    );
  });
}