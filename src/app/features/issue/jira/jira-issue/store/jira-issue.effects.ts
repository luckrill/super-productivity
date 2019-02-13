import { Injectable } from '@angular/core';
import { Actions, Effect, ofType } from '@ngrx/effects';
import { AddOpenJiraIssuesToBacklog, JiraIssueActionTypes } from './jira-issue.actions';
import { select, Store } from '@ngrx/store';
import { concatMap, filter, map, switchMap, tap, throttleTime, withLatestFrom } from 'rxjs/operators';
import { TaskActionTypes, UpdateTask } from '../../../../tasks/store/task.actions';
import { PersistenceService } from '../../../../../core/persistence/persistence.service';
import { selectJiraIssueEntities, selectJiraIssueFeatureState, selectJiraIssueIds } from './jira-issue.reducer';
import { selectCurrentProjectId, selectProjectJiraCfg } from '../../../../project/store/project.reducer';
import { JiraApiService } from '../../jira-api.service';
import { JiraIssueService } from '../jira-issue.service';
import { ConfigService } from '../../../../config/config.service';
import { Dictionary } from '@ngrx/entity';
import { JiraIssue } from '../jira-issue.model';
import { JiraCfg, JiraTransitionOption } from '../../jira';
import { SnackService } from '../../../../../core/snack/snack.service';
import { ProjectActionTypes } from '../../../../project/store/project.actions';
import { Task } from '../../../../tasks/task.model';
import { JIRA_TYPE } from '../../../issue.const';
import {
  selectAllTasks,
  selectCurrentTaskParentOrCurrent,
  selectTaskEntities,
  selectTaskFeatureState
} from '../../../../tasks/store/task.selectors';
import { TaskService } from '../../../../tasks/task.service';
import { EMPTY, Observable, timer } from 'rxjs';
import { TaskState } from '../../../../tasks/store/task.reducer';
import { MatDialog } from '@angular/material';
import { DialogJiraTransitionComponent } from '../../dialog-jira-transition/dialog-jira-transition.component';
import { IssueLocalState } from '../../../issue';
import { DialogConfirmComponent } from '../../../../../ui/dialog-confirm/dialog-confirm.component';
import { DialogJiraAddWorklogComponent } from '../../dialog-jira-add-worklog/dialog-jira-add-worklog.component';
import { JIRA_INITIAL_POLL_BACKLOG_DELAY, JIRA_INITIAL_POLL_DELAY, JIRA_POLL_INTERVAL } from '../../jira.const';
import { isEmail } from '../../../../../util/is-email';

const isEnabled_ = (jiraCfg) => jiraCfg && jiraCfg.isEnabled;
const isEnabled = ([a, jiraCfg]: [any, JiraCfg, any?, any?, any?, any?]) => isEnabled_(jiraCfg);

@Injectable()
export class JiraIssueEffects {
  @Effect({dispatch: false}) pollIssueChangesAndBacklogUpdates: any = this._actions$
    .pipe(
      ofType(
        // while load state should be enough this just might fix the error of polling for inactive projects?
        ProjectActionTypes.LoadProjectRelatedDataSuccess,
        ProjectActionTypes.UpdateProjectIssueProviderCfg,
        JiraIssueActionTypes.LoadState,
      ),
      withLatestFrom(
        this._store$.pipe(select(selectProjectJiraCfg)),
      ),
      switchMap(([a, jiraCfg]) => {
        return (isEnabled([a, jiraCfg]) && jiraCfg.isAutoPollTickets)
          ? this._pollChangesForIssues$
          : EMPTY;
      })
    );

  @Effect() pollNewIssuesToBacklog$: any = this._actions$
    .pipe(
      ofType(
        ProjectActionTypes.LoadProjectRelatedDataSuccess,
        ProjectActionTypes.UpdateProjectIssueProviderCfg,
        JiraIssueActionTypes.LoadState,
      ),
      withLatestFrom(
        this._store$.pipe(select(selectProjectJiraCfg)),
      ),
      switchMap(([a, jiraCfg]) => {
        return (isEnabled([a, jiraCfg]) && jiraCfg.isAutoAddToBacklog)
          ? timer(JIRA_INITIAL_POLL_BACKLOG_DELAY, JIRA_POLL_INTERVAL).pipe(
            tap(() => console.log('JIRA_POLL_BACKLOG_CHANGES')),
            map(() => new AddOpenJiraIssuesToBacklog())
          )
          : EMPTY;
      }),
    );

  @Effect({dispatch: false}) syncIssueStateToLs$: any = this._actions$
    .pipe(
      ofType(
        TaskActionTypes.AddTask,
        TaskActionTypes.DeleteTask,
        TaskActionTypes.RestoreTask,
        TaskActionTypes.MoveToArchive,
        JiraIssueActionTypes.AddJiraIssue,
        JiraIssueActionTypes.DeleteJiraIssue,
        JiraIssueActionTypes.UpdateJiraIssue,
        JiraIssueActionTypes.AddJiraIssues,
        JiraIssueActionTypes.DeleteJiraIssues,
        JiraIssueActionTypes.UpsertJiraIssue,
      ),
      withLatestFrom(
        this._store$.pipe(select(selectCurrentProjectId)),
        this._store$.pipe(select(selectJiraIssueFeatureState)),
      ),
      tap(this._saveToLs.bind(this))
    );

  @Effect({dispatch: false}) addOpenIssuesToBacklog$: any = this._actions$
    .pipe(
      ofType(
        JiraIssueActionTypes.AddOpenJiraIssuesToBacklog,
      ),
      withLatestFrom(
        this._store$.pipe(select(selectAllTasks)),
      ),
      tap(this._importNewIssuesToBacklog.bind(this))
    );


  @Effect({dispatch: false}) addWorklog$: any = this._actions$
    .pipe(
      ofType(
        TaskActionTypes.UpdateTask,
      ),
      withLatestFrom(
        this._store$.pipe(select(selectProjectJiraCfg)),
        this._store$.pipe(select(selectJiraIssueEntities)),
        this._store$.pipe(select(selectTaskEntities)),
      ),
      filter(isEnabled),
      tap(([act_, jiraCfg, jiraEntities, taskEntities]) => {
        const act = act_ as UpdateTask;
        const taskId = act.payload.task.id;
        const isDone = act.payload.task.changes.isDone;
        const task = taskEntities[taskId];

        if (isDone && jiraCfg && jiraCfg.isWorklogEnabled
          && task && task.issueType === JIRA_TYPE
          && !(jiraCfg.isAddWorklogOnSubTaskDone && task.subTaskIds.length > 0)) {
          this._openWorklogDialog(task, jiraEntities[task.issueId]);

        } else {
          const parent = task.parentId && taskEntities[task.parentId];
          if (isDone && parent && jiraCfg.isAddWorklogOnSubTaskDone && parent.issueType === JIRA_TYPE) {
            // NOTE we're still sending the sub task for the meta data we need
            this._openWorklogDialog(task, jiraEntities[parent.issueId]);
          }
        }
      })
    );

  @Effect({dispatch: false}) checkForReassignment: any = this._actions$
    .pipe(
      ofType(
        TaskActionTypes.SetCurrentTask,
        JiraIssueActionTypes.UpdateJiraIssue,
      ),
      withLatestFrom(
        this._store$.pipe(select(selectProjectJiraCfg)),
        this._store$.pipe(select(selectCurrentTaskParentOrCurrent)),
        this._store$.pipe(select(selectJiraIssueEntities)),
      ),
      filter(isEnabled),
      filter(([action, jiraCfg, currentTaskOrParent, issueEntities]) =>
        jiraCfg.isCheckToReAssignTicketOnTaskStart
        && currentTaskOrParent && currentTaskOrParent.issueType === JIRA_TYPE),
      // show every 15s max to give time for updates
      throttleTime(15000),
      // TODO there is probably a better way to to do this
      // TODO refactor to actions
      switchMap(([action, jiraCfg, currentTaskOrParent, issueEntities]) => {
        const issue = issueEntities[currentTaskOrParent.issueId];
        const assignee = issue.assignee;
        const currentUserName = jiraCfg.userAssigneeName || jiraCfg.userName;

        if (isEmail(currentUserName)) {
          this._snackService.open({
            svgIcon: 'jira',
            message: 'Jira: Unable to reassign ticket to yourself, because you didn\'t specify a username. Please visit the settings.',
          });
          return EMPTY;
        } else if (!issue.assignee || issue.assignee.name !== currentUserName) {
          return this._matDialog.open(DialogConfirmComponent, {
            restoreFocus: true,
            data: {
              okTxt: 'Do it!',
              // tslint:disable-next-line
              message: `<strong>${issue.summary}</strong> is currently assigned to <strong>${assignee ? assignee.displayName : 'nobody'}</strong>. Do you want to assign it to yourself?`,
            }
          }).afterClosed()
            .pipe(
              switchMap((isConfirm) => {
                return isConfirm
                  ? this._jiraApiService.updateAssignee(issue.id, currentUserName)
                  : EMPTY;
              }),
              tap(() => {
                this._jiraIssueService.updateIssueFromApi(issue.id, issue, false, false);
              }),
            );
        } else {
          return EMPTY;
        }
      })
    );

  @Effect({dispatch: false}) checkForStartTransition$: Observable<any> = this._actions$
    .pipe(
      ofType(
        TaskActionTypes.SetCurrentTask,
      ),
      withLatestFrom(
        this._store$.pipe(select(selectProjectJiraCfg)),
        this._store$.pipe(select(selectCurrentTaskParentOrCurrent)),
        this._store$.pipe(select(selectJiraIssueEntities)),
      ),
      filter(isEnabled),
      filter(([action, jiraCfg, curOrParTask, issueEntities]) =>
        jiraCfg && jiraCfg.isTransitionIssuesEnabled && curOrParTask && curOrParTask.issueType === JIRA_TYPE),
      concatMap(([action, jiraCfg, curOrParTask, issueEntities]) => {
        const issueData = issueEntities[curOrParTask.issueId];
        return this._handleTransitionForIssue('IN_PROGRESS', jiraCfg, issueData);
      }),
    );

  @Effect({dispatch: false})
  checkForDoneTransition$: Observable<any> = this._actions$
    .pipe(
      ofType(
        TaskActionTypes.UpdateTask,
      ),
      withLatestFrom(
        this._store$.pipe(select(selectProjectJiraCfg)),
        this._store$.pipe(select(selectTaskFeatureState)),
        this._store$.pipe(select(selectJiraIssueEntities)),
      ),
      filter(isEnabled),
      filter(([action, jiraCfg, taskState, issueEntities]: [UpdateTask, JiraCfg, TaskState, Dictionary<JiraIssue>]) => {
        const task = taskState.entities[action.payload.task.id];
        return jiraCfg && jiraCfg.isTransitionIssuesEnabled && task && task.issueType === JIRA_TYPE && task.isDone;
      }),
      concatMap(([action, jiraCfg, taskState, issueEntities]: [UpdateTask, JiraCfg, TaskState, Dictionary<JiraIssue>]) => {
        const task = taskState.entities[action.payload.task.id];
        const issueData = issueEntities[task.issueId];
        return this._handleTransitionForIssue('DONE', jiraCfg, issueData);
      })
    );

  @Effect({dispatch: false}) loadMissingIssues$: any = this._taskService.tasksWithMissingIssueData$
    .pipe(
      withLatestFrom(
        this._store$.pipe(select(selectProjectJiraCfg)),
      ),
      filter(([tasks, jiraCfg]) => isEnabled_(jiraCfg)),
      throttleTime(60 * 1000),
      map(([tasks, jiraCfg]) => tasks.filter(task => task.issueId && task.issueType === JIRA_TYPE)),
      filter((tasks) => tasks && tasks.length > 0),
      tap(tasks => {
        console.warn('TASKS WITH MISSING ISSUE DATA FOR JIRA', tasks);
        this._snackService.open({
          message: 'Jira: Tasks with missing issue data found. Reloading',
          svgIcon: 'jira',
          isSubtle: true,
        });
        tasks.forEach((task) => this._jiraIssueService.loadMissingIssueData(task.issueId));
      })
    );

  private _pollChangesForIssues$: Observable<any> = timer(JIRA_INITIAL_POLL_DELAY, JIRA_POLL_INTERVAL).pipe(
    withLatestFrom(
      this._store$.pipe(select(selectJiraIssueIds)),
      this._store$.pipe(select(selectJiraIssueEntities)),
    ),
    tap(([x, issueIds_, entities]: [number, string[], Dictionary<JiraIssue>]) => {
      const issueIds = issueIds_ as string[];
      console.log('JIRA POLL CHANGES', x, issueIds, entities);
      if (issueIds && issueIds.length > 0) {
        this._snackService.open({
          message: 'Jira: Polling Changes for issues',
          svgIcon: 'jira',
          isSubtle: true,
        });
        issueIds.forEach((id) => this._jiraIssueService.updateIssueFromApi(id, entities[id], true, false));
      }
    }),
  );

  constructor(private readonly _actions$: Actions,
              private readonly _store$: Store<any>,
              private readonly _configService: ConfigService,
              private readonly _snackService: SnackService,
              private readonly _taskService: TaskService,
              private readonly _jiraApiService: JiraApiService,
              private readonly _jiraIssueService: JiraIssueService,
              private readonly _persistenceService: PersistenceService,
              private readonly _matDialog: MatDialog,
  ) {
  }

  private _saveToLs([action, currentProjectId, jiraIssueFeatureState]) {
    if (currentProjectId) {
      this._persistenceService.saveLastActive();
      this._persistenceService.saveIssuesForProject(currentProjectId, JIRA_TYPE, jiraIssueFeatureState);
    } else {
      throw new Error('No current project id');
    }
  }

  private _handleTransitionForIssue(localState: IssueLocalState, jiraCfg: JiraCfg, issue: JiraIssue): Observable<any> {
    const chosenTransition: JiraTransitionOption = jiraCfg.transitionConfig[localState];

    switch (chosenTransition) {
      case 'DO_NOT':
        return EMPTY;
      case 'ALWAYS_ASK':
        return this._openTransitionDialog(issue, localState);
      default:
        if (!chosenTransition || !chosenTransition.id) {
          this._snackService.open({type: 'ERROR', message: 'Jira: No valid transition configured'});
          // NOTE: we would kill the whole effect chain if we do this
          // return throwError({handledError: 'Jira: No valid transition configured'});
          return timer(2000).pipe(concatMap(() => this._openTransitionDialog(issue, localState)));
        }

        if (!issue.status || issue.status.name !== chosenTransition.name) {
          return this._jiraApiService.transitionIssue(issue.id, chosenTransition.id)
            .pipe(
              tap(() => {
                this._snackService.open({
                  type: 'SUCCESS',
                  message: `Jira: Set issue ${issue.key} to <strong>${chosenTransition.name}</strong>`,
                  isSubtle: true,
                });
                this._jiraIssueService.updateIssueFromApi(issue.id, issue, false, false);
              })
            );
        } else {
          // no transition required
          return EMPTY;
        }
    }
  }

  private _openWorklogDialog(task: Task, issue: JiraIssue) {
    this._matDialog.open(DialogJiraAddWorklogComponent, {
      restoreFocus: true,
      data: {
        issue,
        task,
      }
    }).afterClosed()
      .subscribe();
  }

  private _openTransitionDialog(issue: JiraIssue, localState: IssueLocalState): Observable<any> {
    return this._matDialog.open(DialogJiraTransitionComponent, {
      restoreFocus: true,
      data: {
        issue,
        localState,
      }
    }).afterClosed();
  }

  private _importNewIssuesToBacklog([action, allTasks]: [Actions, Task[]]) {
    this._jiraApiService.findAutoImportIssues().subscribe(async (issues: JiraIssue[]) => {
      if (!Array.isArray(issues)) {
        return;
      }
      const allTaskJiraIssueIds = await this._taskService.getAllIssueIds(JIRA_TYPE) as string[];
      console.log('_importNewIssuesToBacklog Jira', allTaskJiraIssueIds, issues);

      const issuesToAdd = issues.filter(issue => !allTaskJiraIssueIds.includes(issue.id));
      issuesToAdd.forEach((issue) => {
        this._taskService.addWithIssue(
          `${issue.key} ${issue.summary}`,
          JIRA_TYPE,
          issue,
          true,
        );
      });

      if (issuesToAdd.length === 1) {
        this._snackService.open({
          message: `Jira: Imported issue "${issuesToAdd[0].key} ${issuesToAdd[0].summary}" from git to backlog`,
          icon: 'cloud_download',
          isSubtle: true,
        });
      } else if (issuesToAdd.length > 1) {
        this._snackService.open({
          message: `Jira: Imported ${issuesToAdd.length} new issues from Jira to backlog`,
          icon: 'cloud_download',
          isSubtle: true,
        });
      }
    });
  }
}

