import { catchError, concatMap, finalize, map, mergeMap, tap } from 'rxjs/operators';
import { Component, OnInit, ElementRef, ViewChild, AfterContentChecked } from '@angular/core';
import { CloudAppRestService, CloudAppEventsService, Request, HttpMethod,  AlertService, CloudAppStoreService, Entity } from '@exlibris/exl-cloudapp-angular-lib';
import { saveAs } from '../../../../node_modules/file-saver/src/FileSaver';
import { SelectEntitiesComponent } from 'eca-select-entities';
import { from, Observable, of } from 'rxjs';


@Component({
  selector: 'app-main',
  templateUrl: './main.component.html',
  styleUrls: ['./main.component.scss']
})
export class MainComponent implements OnInit, AfterContentChecked {

  loading = false;
  selectedEntities = {"users": [], "integration_profiles": []}
  updatedUsers = 0
  createdUsers = 0
  failedUsers = 0
  updateLogText = ""
  upload_integration_profiles = []

  entities$ = this.eventsService.entities$;
  @ViewChild('FILE') FILE: ElementRef;
  @ViewChild(SelectEntitiesComponent) selectEntitiesComponent: SelectEntitiesComponent;

  constructor(
    private restService: CloudAppRestService,
    private eventsService: CloudAppEventsService,
    private alert: AlertService,
    private storeService: CloudAppStoreService 
  ) {}

  ngAfterContentChecked(){
    this.checkOnLoad()
  }

  ngOnInit() {
    this.loading = true;
    this.storeService.get("Users").pipe(finalize(() => {this.loading = false })).subscribe( records => {
      if (records) {
      this.selectedEntities.users = records;  
      }
    })
    this.restService.call('/conf/integration-profiles?limit=100').subscribe(result =>
      this.selectedEntities.integration_profiles = result['integration_profile']) 
  }

  entitySelected() { 
    if (this.selectEntitiesComponent == undefined){
      return
    }
    this.storeService.set("Users", this.selectedEntities.users).subscribe(response=>{console.log('Saved');}, 
      error => console.log('Failed to save entitiy: ' + error.message))      
  }

  save() {
    const selectedApi = {"users": [], "integration_profiles": this.selectedEntities.integration_profiles }
    this.loading = true;
    const users = this.selectedEntities.users;

    from(users).pipe(
      mergeMap(user => {    
        return this.restService.call<any>(user.link).pipe(
          map(result => selectedApi.users.push(result)),
          catchError(error => {this.alert.error('Failed to retrieve entity: ' + error.message); return of(Observable)}),
        )
      }),
      finalize(() => {
        let str = JSON.stringify(selectedApi, null, 3)         
        let file = new Blob([str], { type: 'json;charset=utf-8'})
        saveAs(file, 'Backup.txt')
        this.loading = false;})
    ).subscribe() 
  }

  upload(file: File) {
    this.loading = true
    file = file[0];
    const reader = new FileReader();
    reader.readAsText(file)
    this.FILE.nativeElement.value = ""
    this.updateLogText = ""
    reader.onload = () => {  
      let upload = this.tryParseJson(reader.result.toString())
      if (upload !== undefined) { // File is not empty
        if (upload.integration_profiles !== undefined) { // Integration profiles array exist
          this.upload_integration_profiles = upload.integration_profiles
        }
        if (upload.users !== undefined) { // Users array exist
          from(upload.users).pipe(
            mergeMap((user: any) => {
              let url = "/users/" + user.primary_id     
              return this.restService.call<any>(url).pipe(
                concatMap(() =>  this.update(user, url)), // User exists - update it
                catchError(error => {
                  if (error.status === 400) { // User doesn't exist - create new  
                    return this.create(user,'/users');
                  } else {
                    this.alert.error('Failed to retrieve entity: ' + error.message);
                    return of(Observable);
                  }
                }),
              )
            }),
            finalize(() => this.printAlertMessage())
          ).subscribe() 
        }
        else { // Users array doesn't exist       
          this.printAlertMessage()
          this.loading = false;
        } 
      }
      else { // Invalid file format
        this.alert.error('File format is invalid')
        this.loading = false;
      }
    }
    
  }

  update(value: any, url: any) {
    const requestBody = value;
    let request: Request = {
      url: url, 
      method: HttpMethod.PUT,
      requestBody
    };
    return this.restService.call(request).pipe(
      tap((record) => {this.printUpdateLog(record)}), 
      catchError(err => {this.printUpdateFailedLog(value, err);
        console.log(err);
        return of(Observable)}))
  }

  create(value: any, url: any) {
    const requestBody = value;
    let request: Request = {
      url: url, 
      method: HttpMethod.POST,
      requestBody
    };
    return this.restService.call(request).pipe(
      tap((record) => {this.printCreatedLog(record)}), 
      catchError(err => {this.printCreatedFailedLog(value, err);
        console.log(err);
        return of(Observable)})) 
  }

  printUpdateLog(record: any){
    let userName = record.first_name + " " + record.last_name + " (" + record.primary_id + ")"
    this.updatedUsers++;
    this.updateLogText += userName + ": Updated successfully\n";
  }

  printCreatedLog(record: any){
    let userName = record.first_name + " " + record.last_name + " (" + record.primary_id + ")"
    this.createdUsers++;
    this.updateLogText += userName + ": Created successfully\n";
  }

  printUpdateFailedLog(record:any, error:any){
    let userName = record.first_name + " " + record.last_name + " (" + record.primary_id + ")"
    this.failedUsers++;
    this.updateLogText += userName + ": Failed to update - " + error.message + "\n";
  }

  printCreatedFailedLog(record:any, error:any){
    let userName = record.first_name + " " + record.last_name + " (" + record.primary_id + ")"
    this.failedUsers++;
    this.updateLogText += userName + ": Failed to create - " + error.message + "\n";
  }

  printAlertMessage(){
    let users_updated = 'Users Updated: '+ this.updatedUsers;
    let users_created = 'Users Created: ' + this.createdUsers;
    let users_failed = 'Users Failed: ' + this.failedUsers;

    this.alert.success(users_updated, { delay: 20000 })
    this.alert.success(users_created, { delay: 20000 })
    if (this.failedUsers !== 0) {
      this.alert.error(users_failed)
    }    
    this.failedUsers = 0;
    this.updatedUsers = 0;
    this.createdUsers = 0;
    this.loading=false;
  }
  
  private tryParseJson(value: any) {
    try {
      return JSON.parse(value);
    } catch (e) {
      console.error(e);
    }
    return undefined;
  }

  private checkOnLoad(){
    if (this.selectEntitiesComponent){
      this.selectEntitiesComponent.selected = this.selectedEntities.users
    }
    if (this.selectEntitiesComponent){
      let numberOfitems = this.selectEntitiesComponent.items.length;
      let numberOfChecked = 0
      for (let item of this.selectedEntities.users){
        this.selectEntitiesComponent.items.forEach(value =>{
          if (value.value.id == item.id){
            value.checked = true
            numberOfChecked++;
          }
        })         
      }
      if (numberOfChecked == numberOfitems){
          this.selectEntitiesComponent.masterChecked = true;
          this.selectEntitiesComponent.masterIndeterminate = false;
      }
      else if (numberOfChecked < numberOfitems && numberOfChecked != 0){
        this.selectEntitiesComponent.masterIndeterminate = true;
        this.selectEntitiesComponent.masterChecked = false;
      }
    }  
  }

  removeUser(entity: Entity){
    this.selectedEntities.users = this.selectedEntities.users.filter(item => {return item.id !== entity.id})
    this.storeService.set("Users", this.selectedEntities.users).subscribe(response=>{console.log('Saved');}, 
      error => console.log('Failed to save entitiy: ' + error.message))
    for (let item of this.selectEntitiesComponent.items){
      if (item.value.id == entity.id){
         item.checked = false;
         break
      } 
    }
    let numberOfitems = this.selectEntitiesComponent.items.length;
    let numberOfChecked = 0;
    this.selectEntitiesComponent.items.forEach(value =>{
      if (value.checked){
        numberOfChecked++;
      }
    })
    if (numberOfChecked == 0){
      this.selectEntitiesComponent.masterIndeterminate = false;
      this.selectEntitiesComponent.masterChecked = false;
    }
    else if (numberOfChecked < numberOfitems){
      this.selectEntitiesComponent.masterIndeterminate = true;
      this.selectEntitiesComponent.masterChecked = false;
    }    
  }
}